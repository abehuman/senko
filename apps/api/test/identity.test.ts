import { describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../src/api-key";
import type { DatabaseClient } from "../src/database";
import { createPostgresIdentityService } from "../src/identity";
import type { CloudflareBindings } from "../src/types";

const DATABASE_URL =
	"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require";
const HASH_SECRET = "test-hash-secret-that-is-at-least-32-bytes-long";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const KEY_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "00000000-0000-4000-8000-000000000003";

function env(): CloudflareBindings {
	return { SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET, SENKO_DATABASE_URL: DATABASE_URL };
}

describe("PostgreSQL API key authentication", () => {
	it("resolves an active key to internal account, key, and scope IDs", async () => {
		const generated = await generateApiKey(HASH_SECRET);
		const query = vi.fn(async (text: string) => {
			if (text.includes("from api_keys k")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							account_status: "active",
							expires_at: null,
							hash_version: 1,
							key_hash: generated.hash,
							key_id: KEY_ID,
							key_status: "active",
							public_id: generated.publicId,
							scopes: ["models:read"],
							team_status: null,
						},
					],
				};
			}
			throw new Error("Unexpected query");
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(service.authenticate(env(), `Bearer ${generated.rawKey}`)).resolves.toEqual({
			ok: true,
			value: { accountId: ACCOUNT_ID, keyId: KEY_ID, publicId: generated.publicId, scopes: ["models:read"] },
		});
		expect(query).toHaveBeenCalledWith(expect.stringContaining("where k.public_id = $1"), [generated.publicId]);
		expect(client.end).toHaveBeenCalledOnce();
	});

	it.each([
		["wrong secret", { account_status: "active", expires_at: null, key_status: "active", team_status: null }],
		[
			"expired",
			{ account_status: "active", expires_at: "2020-01-01T00:00:00.000Z", key_status: "active", team_status: null },
		],
		["revoked", { account_status: "active", expires_at: null, key_status: "revoked", team_status: null }],
		["disabled account", { account_status: "suspended", expires_at: null, key_status: "active", team_status: null }],
		["archived team", { account_status: "active", expires_at: null, key_status: "active", team_status: "archived" }],
	])("returns the same not-found result for a %s", async (scenario, lifecycle) => {
		const presented = await generateApiKey(HASH_SECRET);
		const stored = scenario === "wrong secret" ? await generateApiKey(HASH_SECRET) : presented;
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query: vi.fn().mockResolvedValue({
				rows: [
					{
						...lifecycle,
						account_id: ACCOUNT_ID,
						hash_version: 1,
						key_hash: stored.hash,
						key_id: KEY_ID,
						public_id: presented.publicId,
						scopes: ["models:read"],
					},
				],
			}),
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(service.authenticate(env(), `Bearer ${presented.rawKey}`)).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("returns the same not-found result for an unknown public ID", async () => {
		const presented = await generateApiKey(HASH_SECRET);
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query: vi.fn().mockResolvedValue({ rows: [] }),
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);
		await expect(service.authenticate(env(), `Bearer ${presented.rawKey}`)).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("fails closed when database configuration or connectivity is unavailable", async () => {
		const service = createPostgresIdentityService(() => {
			throw new Error("cannot create client");
		});
		await expect(service.authenticate({}, "Bearer any")).resolves.toMatchObject({
			message: expect.stringContaining("SENKO_DATABASE_URL"),
			ok: false,
			reason: "configuration_error",
		});
		const generated = await generateApiKey(HASH_SECRET);
		await expect(service.authenticate(env(), `Bearer ${generated.rawKey}`)).resolves.toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it("rejects a malformed key without opening a database connection", async () => {
		const factory = vi.fn(() => {
			throw new Error("should not connect");
		});
		const service = createPostgresIdentityService(factory);
		await expect(service.authenticate(env(), "Bearer malformed-key")).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(factory).not.toHaveBeenCalled();
	});

	it("lists bounded account metadata with a validated cursor", async () => {
		const cursorId = "00000000-0000-4000-8000-000000000004";
		const nextId = "00000000-0000-4000-8000-000000000005";
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			if (text === "select id from accounts where id = $1") return { rows: [{ id: cursorId }] };
			if (text.includes("from accounts") && text.includes("order by created_at")) {
				expect(values).toEqual([cursorId, 2]);
				return {
					rows: [
						{
							created_at: "2026-08-24T00:02:00.000Z",
							id: nextId,
							name: "Next account",
							plan_key: "beta",
							status: "active",
							suspended_at: null,
						},
						{
							created_at: "2026-08-24T00:01:00.000Z",
							id: cursorId,
							name: "Cursor account",
							plan_key: "beta",
							status: "suspended",
							suspended_at: "2026-08-24T00:03:00.000Z",
						},
					],
				};
			}
			throw new Error("Unexpected query");
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(service.listAccounts(env(), { limit: 1, startingAfter: cursorId })).resolves.toEqual({
			ok: true,
			value: {
				data: [
					{
						createdAt: "2026-08-24T00:02:00.000Z",
						id: nextId,
						name: "Next account",
						planKey: "beta",
						status: "active",
						suspendedAt: null,
					},
				],
				hasMore: true,
			},
		});
		expect(query).toHaveBeenCalledWith("select id from accounts where id = $1", [cursorId]);
	});

	it("issues the full key once without placing it in an insert or audit query", async () => {
		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text.startsWith("select status from accounts")) {
				return { rows: [{ status: "active" }] };
			}
			if (text.includes("insert into api_keys")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:00:00.000Z",
							expires_at: null,
							id: KEY_ID,
							key_prefix: values?.[4],
							name: "CLI",
							public_id: values?.[3],
							status: "active",
							team_id: null,
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);
		const issued = await service.issueApiKey(env(), {
			accountId: ACCOUNT_ID,
			expiresAt: null,
			name: "CLI",
			requestId: "req_test",
			scopes: ["models:read"],
			teamId: null,
		});

		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		expect(issued.value.key).toMatch(/^sk-senko-v1-/);
		expect(JSON.stringify(queries)).not.toContain(issued.value.key);
		expect(queries.find((entry) => entry.text.includes("insert into api_keys"))?.values?.[5]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("coalesces successful last-used updates inside one Worker isolate", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [] });
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const factory = vi.fn(() => client);
		const service = createPostgresIdentityService(factory);

		await expect(service.touchLastUsed(env(), KEY_ID)).resolves.toEqual({ ok: true, value: undefined });
		await expect(service.touchLastUsed(env(), KEY_ID)).resolves.toEqual({ ok: true, value: undefined });
		expect(factory).toHaveBeenCalledOnce();
		expect(query).toHaveBeenCalledOnce();
	});

	it("does not issue a key when its team belongs to another account", async () => {
		const teamId = "00000000-0000-4000-8000-000000000003";
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "active" }] };
			if (text.startsWith("select status from teams")) return { rows: [] };
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);
		await expect(
			service.issueApiKey(env(), {
				accountId: ACCOUNT_ID,
				expiresAt: null,
				name: "Cross-account attempt",
				requestId: "req_test",
				scopes: ["models:read"],
				teamId,
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
		expect(query).toHaveBeenCalledWith(expect.stringContaining("account_id = $2"), [teamId, ACCOUNT_ID]);
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into api_keys"))).toBe(false);
	});

	it("makes repeated revocation idempotent without duplicating its audit event", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.includes("from api_keys where id")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:00:00.000Z",
							expires_at: null,
							id: KEY_ID,
							key_prefix: "sk-senko-v1-public",
							name: "CLI",
							public_id: "public-key-id",
							status: "revoked",
							team_id: null,
						},
					],
				};
			}
			if (text.startsWith("select scope")) return { rows: [{ scope: "models:read" }] };
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.revokeApiKey(env(), { accountId: ACCOUNT_ID, keyId: KEY_ID, requestId: "req_retry" }),
		).resolves.toMatchObject({ ok: true, value: { id: KEY_ID, status: "revoked" } });
		expect(query.mock.calls.some(([text]) => String(text).includes("update api_keys"))).toBe(false);
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into admin_audit_events"))).toBe(false);
	});

	it("lists bounded account-owned key metadata without hashes or plaintext", async () => {
		const cursorId = "00000000-0000-4000-8000-000000000003";
		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text === "select id from accounts where id = $1") return { rows: [{ id: ACCOUNT_ID }] };
			if (text.startsWith("select id from api_keys where id")) return { rows: [{ id: cursorId }] };
			if (text.includes("left join lateral")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:02:00.000Z",
							expires_at: null,
							id: KEY_ID,
							key_prefix: "sk-senko-v1-public",
							last_used_at: null,
							name: "CLI",
							public_id: "public-key-id",
							replaces_api_key_id: cursorId,
							revoked_at: null,
							rotation_group_id: cursorId,
							scopes: ["models:read"],
							status: "active",
							team_id: null,
						},
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:01:00.000Z",
							expires_at: null,
							id: cursorId,
							key_prefix: "sk-senko-v1-older",
							name: "Older",
							public_id: "older-public-id",
							rotation_group_id: cursorId,
							scopes: ["models:read"],
							status: "active",
							team_id: null,
						},
					],
				};
			}
			throw new Error("Unexpected query");
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);
		const result = await service.listApiKeys(env(), { accountId: ACCOUNT_ID, limit: 1, startingAfter: cursorId });

		expect(result).toMatchObject({
			ok: true,
			value: { data: [{ id: KEY_ID, replacesApiKeyId: cursorId }], hasMore: true },
		});
		expect(queries.find((entry) => entry.text.includes("left join lateral"))?.values).toEqual([
			ACCOUNT_ID,
			cursorId,
			2,
		]);
		expect(JSON.stringify(result)).not.toContain("key_hash");
		expect(JSON.stringify(result)).not.toContain("sk-senko-v1-public-secret");
	});

	it("rotates a key inside one transaction and inherits its usage-limit policy", async () => {
		const rotatedId = "00000000-0000-4000-8000-000000000004";
		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "active" }] };
			if (text.startsWith("select account_id from account_usage_limits")) return { rows: [{ account_id: ACCOUNT_ID }] };
			if (text.includes("for update of k")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							account_status: "active",
							created_at: "2026-08-24T00:00:00.000Z",
							expires_at: null,
							id: KEY_ID,
							key_prefix: "sk-senko-v1-public",
							name: "CLI",
							public_id: "public-key-id",
							rotation_group_id: KEY_ID,
							status: "active",
							team_id: null,
							team_status: null,
						},
					],
				};
			}
			if (text.includes("from api_key_usage_limits")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							currency: "USD",
							daily_cost_microunits: "10000",
							max_request_cost_microunits: "100",
							minute_input_tokens: "1000",
							minute_output_tokens: "500",
							monthly_cost_microunits: "100000",
							policy_version: "key-policy-1",
						},
					],
				};
			}
			if (text.startsWith("select scope"))
				return { rows: [{ scope: "inference:responses" }, { scope: "models:read" }] };
			if (text.includes("insert into api_keys")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:01:00.000Z",
							expires_at: null,
							id: rotatedId,
							key_prefix: values?.[4],
							last_used_at: null,
							name: values?.[2],
							public_id: values?.[3],
							replaces_api_key_id: KEY_ID,
							revoked_at: null,
							rotation_group_id: KEY_ID,
							status: "active",
							team_id: null,
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);
		const rotated = await service.rotateApiKey(env(), {
			accountId: ACCOUNT_ID,
			keyId: KEY_ID,
			name: "CLI next",
			requestId: "req_rotate",
		});

		expect(rotated).toMatchObject({
			ok: true,
			value: { id: rotatedId, name: "CLI next", replacesApiKeyId: KEY_ID, rotationGroupId: KEY_ID },
		});
		expect(query.mock.calls.some(([text]) => String(text).startsWith("update api_keys"))).toBe(false);
		expect(query).toHaveBeenCalledWith(
			expect.stringContaining("api_key.rotated"),
			expect.arrayContaining([ACCOUNT_ID, rotatedId, "req_rotate"]),
		);
		const accountLimitLock = queries.findIndex((entry) => entry.text.includes("from account_usage_limits"));
		const sourceKeyLock = queries.findIndex((entry) => entry.text.includes("for update of k"));
		const sourceKeyLimitLock = queries.findIndex((entry) => entry.text.includes("from api_key_usage_limits"));
		const rotatedKeyInsert = queries.findIndex((entry) => entry.text.includes("insert into api_keys"));
		const rotatedKeyLimitInsert = queries.findIndex((entry) => entry.text.includes("insert into api_key_usage_limits"));
		expect(accountLimitLock).toBeLessThan(sourceKeyLock);
		expect(sourceKeyLock).toBeLessThan(sourceKeyLimitLock);
		expect(sourceKeyLimitLock).toBeLessThan(rotatedKeyInsert);
		expect(rotatedKeyInsert).toBeLessThan(rotatedKeyLimitInsert);
		expect(queries[rotatedKeyLimitInsert]?.values).toEqual([
			rotatedId,
			ACCOUNT_ID,
			"key-policy-1",
			"USD",
			"1000",
			"500",
			"100",
			"10000",
			"100000",
		]);
		expect(queries.find((entry) => entry.text.includes("api_key.rotated"))?.values?.[3]).toContain(
			'"usage_limits_inherited":true',
		);
		if (rotated.ok) expect(JSON.stringify(queries)).not.toContain(rotated.value.key);
	});

	it("serializes team-bound rotation with team archive and rejects an archived team", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "active" }] };
			if (text.includes("for update of k")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							account_status: "active",
							created_at: "2026-08-24T00:00:00.000Z",
							expires_at: null,
							id: KEY_ID,
							key_prefix: "sk-senko-v1-public",
							name: "CLI",
							public_id: "public-key-id",
							rotation_group_id: KEY_ID,
							status: "active",
							team_id: TEAM_ID,
							team_status: "active",
						},
					],
				};
			}
			if (text.startsWith("select status from teams")) return { rows: [{ status: "archived" }] };
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.rotateApiKey(env(), {
				accountId: ACCOUNT_ID,
				keyId: KEY_ID,
				requestId: "req_rotate",
			}),
		).resolves.toEqual({ ok: false, reason: "conflict" });
		expect(query).toHaveBeenCalledWith("select status from teams where id = $1 and account_id = $2 for share", [
			TEAM_ID,
			ACCOUNT_ID,
		]);
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into api_keys"))).toBe(false);
	});

	it("creates an account-owned team and audit event in one transaction", async () => {
		const teamId = "00000000-0000-4000-8000-000000000005";
		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "active" }] };
			if (text.includes("insert into teams")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:00:00.000Z",
							id: teamId,
							name: values?.[1],
							status: "active",
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.createTeam(env(), { accountId: ACCOUNT_ID, name: "Platform", requestId: "req_team" }),
		).resolves.toEqual({
			ok: true,
			value: {
				accountId: ACCOUNT_ID,
				createdAt: "2026-08-24T00:00:00.000Z",
				id: teamId,
				name: "Platform",
				status: "active",
			},
		});
		expect(query).toHaveBeenCalledWith(expect.stringContaining("team.created"), [ACCOUNT_ID, teamId, "req_team"]);
		expect(queries.map((entry) => entry.text)).toEqual([
			"begin",
			expect.stringContaining("select status from accounts"),
			expect.stringContaining("insert into teams"),
			expect.stringContaining("insert into admin_audit_events"),
			"commit",
		]);
	});

	it.each([
		["missing", [], "not_found"],
		["suspended", [{ status: "suspended" }], "conflict"],
	] as const)("does not create a team for a %s account", async (_scenario, accountRows, reason) => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select status from accounts")) return { rows: accountRows };
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.createTeam(env(), { accountId: ACCOUNT_ID, name: "Platform", requestId: "req_team" }),
		).resolves.toEqual({ ok: false, reason });
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into teams"))).toBe(false);
		expect(query).toHaveBeenLastCalledWith("rollback");
	});

	it("lists teams with an account-bound cursor and bounded page", async () => {
		const cursorId = "00000000-0000-4000-8000-000000000005";
		const nextId = "00000000-0000-4000-8000-000000000006";
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select id from accounts")) return { rows: [{ id: ACCOUNT_ID }] };
			if (text.startsWith("select id from teams")) return { rows: [{ id: cursorId }] };
			if (text.includes("from teams") && text.includes("order by created_at")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:02:00.000Z",
							id: nextId,
							name: "Platform",
							status: "active",
						},
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:01:00.000Z",
							id: cursorId,
							name: "Archived",
							status: "archived",
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.listTeams(env(), { accountId: ACCOUNT_ID, limit: 1, startingAfter: cursorId }),
		).resolves.toEqual({
			ok: true,
			value: {
				data: [
					{
						accountId: ACCOUNT_ID,
						createdAt: "2026-08-24T00:02:00.000Z",
						id: nextId,
						name: "Platform",
						status: "active",
					},
				],
				hasMore: true,
			},
		});
		expect(query).toHaveBeenCalledWith("select id from teams where id = $1 and account_id = $2", [
			cursorId,
			ACCOUNT_ID,
		]);
	});

	it("lists content-free audit events with an account-bound cursor", async () => {
		const cursorId = "00000000-0000-4000-8000-000000000005";
		const eventId = "00000000-0000-4000-8000-000000000006";
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select id from accounts")) return { rows: [{ id: ACCOUNT_ID }] };
			if (text.startsWith("select id from admin_audit_events")) return { rows: [{ id: cursorId }] };
			if (text.includes("from admin_audit_events") && text.includes("order by created_at")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							action: "team.archived",
							actor_type: "system",
							created_at: "2026-08-24T00:02:00.000Z",
							id: eventId,
							request_id: "req_00000000000000000000000000000000",
							target_id: TEAM_ID,
							target_type: "team",
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		const result = await service.listAuditEvents(env(), {
			accountId: ACCOUNT_ID,
			limit: 1,
			startingAfter: cursorId,
		});
		expect(result).toEqual({
			ok: true,
			value: {
				data: [
					{
						accountId: ACCOUNT_ID,
						action: "team.archived",
						actorType: "system",
						createdAt: "2026-08-24T00:02:00.000Z",
						id: eventId,
						requestId: "req_00000000000000000000000000000000",
						targetId: TEAM_ID,
						targetType: "team",
					},
				],
				hasMore: false,
			},
		});
		expect(query).toHaveBeenCalledWith("select id from admin_audit_events where id = $1 and account_id = $2", [
			cursorId,
			ACCOUNT_ID,
		]);
		expect(JSON.stringify(result)).not.toContain("metadata");
	});

	it("fails closed when a stored audit row is outside the response allowlist", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select id from accounts")) return { rows: [{ id: ACCOUNT_ID }] };
			if (text.includes("from admin_audit_events")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							action: "future.action.without.contract_review",
							actor_type: "system",
							created_at: "2026-08-24T00:02:00.000Z",
							id: "00000000-0000-4000-8000-000000000006",
							request_id: "req_00000000000000000000000000000000",
							target_id: TEAM_ID,
							target_type: "team",
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.listAuditEvents(env(), { accountId: ACCOUNT_ID, limit: 50, startingAfter: null }),
		).resolves.toEqual({ ok: false, reason: "unavailable" });
	});

	it.each([
		["active", "archived", "team.archived"],
		["archived", "active", "team.reactivated"],
	] as const)("changes a team from %s to %s with one audit event", async (currentStatus, nextStatus, action) => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "active" }] };
			if (text.startsWith("select id, account_id")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:00:00.000Z",
							id: TEAM_ID,
							name: "Platform",
							status: currentStatus,
						},
					],
				};
			}
			if (text.startsWith("update teams")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							created_at: "2026-08-24T00:00:00.000Z",
							id: TEAM_ID,
							name: "Platform",
							status: nextStatus,
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.setTeamStatus(env(), {
				accountId: ACCOUNT_ID,
				requestId: "req_team_status",
				status: nextStatus,
				teamId: TEAM_ID,
			}),
		).resolves.toMatchObject({ ok: true, value: { id: TEAM_ID, status: nextStatus } });
		expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into admin_audit_events"), [
			ACCOUNT_ID,
			action,
			TEAM_ID,
			"req_team_status",
		]);
	});

	it("does not reactivate a team while its account is suspended", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "suspended" }] };
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.setTeamStatus(env(), {
				accountId: ACCOUNT_ID,
				requestId: "req_team_status",
				status: "active",
				teamId: TEAM_ID,
			}),
		).resolves.toEqual({ ok: false, reason: "conflict" });
		expect(query.mock.calls.some(([text]) => String(text).includes("from teams"))).toBe(false);
		expect(query).toHaveBeenLastCalledWith("rollback");
	});

	it.each([
		["active", "suspended", "account.suspended"],
		["suspended", "active", "account.reactivated"],
	] as const)("changes an account from %s to %s with one audit event", async (currentStatus, nextStatus, action) => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select id, name, status")) {
				return {
					rows: [
						{
							created_at: "2026-08-24T00:00:00.000Z",
							id: ACCOUNT_ID,
							name: "Example",
							plan_key: "beta",
							status: currentStatus,
							suspended_at: currentStatus === "suspended" ? "2026-08-24T00:01:00.000Z" : null,
						},
					],
				};
			}
			if (text.startsWith("update accounts")) {
				return {
					rows: [
						{
							created_at: "2026-08-24T00:00:00.000Z",
							id: ACCOUNT_ID,
							name: "Example",
							plan_key: "beta",
							status: nextStatus,
							suspended_at: nextStatus === "suspended" ? "2026-08-24T00:02:00.000Z" : null,
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);
		const result = await service.setAccountStatus(env(), {
			accountId: ACCOUNT_ID,
			requestId: "req_status",
			status: nextStatus,
		});

		expect(result).toMatchObject({ ok: true, value: { id: ACCOUNT_ID, status: nextStatus } });
		expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into admin_audit_events"), [
			ACCOUNT_ID,
			action,
			"req_status",
		]);
	});

	it("keeps repeated account suspension idempotent without duplicate audit events", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.startsWith("select id, name, status")) {
				return {
					rows: [
						{
							created_at: "2026-08-24T00:00:00.000Z",
							id: ACCOUNT_ID,
							name: "Example",
							plan_key: "beta",
							status: "suspended",
							suspended_at: "2026-08-24T00:01:00.000Z",
						},
					],
				};
			}
			return { rows: [] };
		});
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end: vi.fn().mockResolvedValue(undefined),
			query,
		} as unknown as DatabaseClient;
		const service = createPostgresIdentityService(() => client);

		await expect(
			service.setAccountStatus(env(), {
				accountId: ACCOUNT_ID,
				requestId: "req_repeat",
				status: "suspended",
			}),
		).resolves.toMatchObject({ ok: true, value: { status: "suspended" } });
		expect(query.mock.calls.some(([text]) => String(text).startsWith("update accounts"))).toBe(false);
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into admin_audit_events"))).toBe(false);
	});
});
