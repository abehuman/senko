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
});
