import { describe, expect, it, vi } from "vitest";
import type { AdmissionClient } from "../src/admission";
import type { AdmissionRateLimit } from "../src/admission-state";
import { createApp } from "../src/app";
import type { IdentityService } from "../src/identity";
import type { CloudflareBindings } from "../src/types";

const MODEL_ID = "provider/coding-model";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const KEY_ID = "00000000-0000-4000-8000-000000000002";
const ADMIN_TOKEN = "test-admin-token-that-is-at-least-32-bytes-long";
const RATE_LIMIT: AdmissionRateLimit = {
	limitConcurrentRequests: 2,
	limitRequests: 20,
	remainingConcurrentRequests: 1,
	remainingRequests: 19,
	resetSeconds: 60,
};

function env(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
		SENKO_ADMIN_TOKEN: ADMIN_TOKEN,
		SENKO_AUTH_MODE: "database",
		SENKO_FAST_MODEL: MODEL_ID,
		LLM_API_BASE_URL: "https://llm.example/v1/",
		LLM_API_KEY: "llm-secret",
		SENKO_MODELS: JSON.stringify([
			{
				context_window: 131_072,
				id: MODEL_ID,
				input_modalities: ["text"],
				max_output_tokens: 16_384,
				reasoning: true,
				supported_protocols: ["openai-completions", "openai-responses"],
			},
		]),
		...overrides,
	};
}

function identity(overrides: Partial<IdentityService> = {}): IdentityService {
	return {
		async authenticate() {
			return {
				ok: true,
				value: { accountId: ACCOUNT_ID, keyId: KEY_ID, publicId: "public-key-id", scopes: ["models:read"] },
			};
		},
		async createAccount() {
			return {
				ok: true,
				value: {
					createdAt: "2026-08-24T00:00:00.000Z",
					id: ACCOUNT_ID,
					name: "Test account",
					planKey: "beta",
					status: "active",
				},
			};
		},
		async issueApiKey() {
			return {
				ok: true,
				value: {
					accountId: ACCOUNT_ID,
					createdAt: "2026-08-24T00:00:00.000Z",
					expiresAt: null,
					id: KEY_ID,
					key: "sk-senko-v1-public-secret",
					keyPrefix: "sk-senko-v1-public",
					name: "CLI",
					publicId: "public-key-id",
					scopes: ["models:read"],
					status: "active",
					teamId: null,
				},
			};
		},
		async revokeApiKey() {
			return {
				ok: true,
				value: {
					accountId: ACCOUNT_ID,
					createdAt: "2026-08-24T00:00:00.000Z",
					expiresAt: null,
					id: KEY_ID,
					keyPrefix: "sk-senko-v1-public",
					name: "CLI",
					publicId: "public-key-id",
					scopes: ["models:read"],
					status: "revoked",
					teamId: null,
				},
			};
		},
		async touchLastUsed() {
			return { ok: true, value: undefined };
		},
		...overrides,
	};
}

describe("database-backed identity routes", () => {
	it("authenticates a database key, enforces scope, and defers last-used persistence", async () => {
		const touchLastUsed = vi.fn<IdentityService["touchLastUsed"]>().mockResolvedValue({ ok: true, value: undefined });
		const waitUntil = vi.fn();
		const app = createApp({ identityService: identity({ touchLastUsed }) });
		const response = await app.request("/v1/models", { headers: { authorization: "Bearer managed-key" } }, env(), {
			waitUntil,
		} as unknown as ExecutionContext);

		expect(response.status).toBe(200);
		expect(touchLastUsed).toHaveBeenCalledWith(expect.any(Object), KEY_ID);
		expect(waitUntil).toHaveBeenCalledOnce();
	});

	it("rejects a valid key that lacks the endpoint scope", async () => {
		const app = createApp({ identityService: identity() });
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: MODEL_ID }),
				headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "insufficient_scope" } });
	});

	it("attributes database-key admission to its owning account", async () => {
		const acquire = vi.fn<AdmissionClient["acquire"]>(async (_env, _accountId, _keyId, leaseId) => ({
			leaseExpiresAt: Date.now() + 90_000,
			leaseId,
			ok: true,
			rateLimit: RATE_LIMIT,
		}));
		const app = createApp({
			admissionClient: {
				acquire,
				async release() {
					return true;
				},
				async renew() {
					return { leaseExpiresAt: Date.now() + 90_000, ok: true };
				},
			},
			identityService: identity({
				async authenticate() {
					return {
						ok: true,
						value: {
							accountId: ACCOUNT_ID,
							keyId: KEY_ID,
							publicId: "public-key-id",
							scopes: ["inference:responses"],
						},
					};
				},
			}),
			llmApiFetch: async () => Response.json({ id: "resp_test", model: MODEL_ID, object: "response" }),
		});
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: MODEL_ID }),
				headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
				method: "POST",
			},
			env(),
		);

		expect(response.status).toBe(200);
		await response.text();
		expect(acquire).toHaveBeenCalledWith(
			expect.any(Object),
			ACCOUNT_ID,
			KEY_ID,
			expect.any(String),
			expect.any(Number),
		);
	});

	it("returns a safe 503 when identity storage is unavailable", async () => {
		const app = createApp({
			identityService: identity({
				async authenticate() {
					return { ok: false, reason: "unavailable" };
				},
			}),
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const response = await app.request("/v1/models", { headers: { authorization: "Bearer managed-key" } }, env());
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({ error: { code: "identity_unavailable" } });
			expect(warning).toHaveBeenCalledWith(expect.stringContaining('"event":"identity_database_unavailable"'));
		} finally {
			warning.mockRestore();
		}
	});

	it("protects account provisioning and key issuance with a separate management token", async () => {
		const issueApiKey = vi.fn<IdentityService["issueApiKey"]>(identity().issueApiKey);
		const app = createApp({ identityService: identity({ issueApiKey }) });
		const path = `/admin/v1/accounts/${ACCOUNT_ID}/api-keys`;
		const request = {
			body: JSON.stringify({ name: "CLI", scopes: ["models:read"] }),
			headers: { "content-type": "application/json" },
			method: "POST",
		};
		const unauthorized = await app.request(path, request, env());
		expect(unauthorized.status).toBe(401);

		const response = await app.request(
			path,
			{ ...request, headers: { ...request.headers, authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			account_id: ACCOUNT_ID,
			id: KEY_ID,
			key: "sk-senko-v1-public-secret",
			warning: expect.stringContaining("cannot be retrieved"),
		});
		expect(issueApiKey).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, name: "CLI", scopes: ["models:read"] }),
		);
	});

	it("revokes only a key inside the account named by the route", async () => {
		const revokeApiKey = vi.fn<IdentityService["revokeApiKey"]>(identity().revokeApiKey);
		const app = createApp({ identityService: identity({ revokeApiKey }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/api-keys/${KEY_ID}/revoke`,
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" },
			env(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: KEY_ID, status: "revoked" });
		expect(revokeApiKey).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, keyId: KEY_ID }),
		);
	});
});
