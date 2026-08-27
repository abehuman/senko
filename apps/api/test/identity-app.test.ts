import { describe, expect, it, vi } from "vitest";
import type { AdmissionClient } from "../src/admission";
import type { AdmissionRateLimit } from "../src/admission-state";
import { createApp } from "../src/app";
import type { IdentityService } from "../src/identity";
import type { OperationalLogger } from "../src/observability";
import type { ProviderPoolClient } from "../src/provider-pool";
import type { SupportService } from "../src/support";
import type { CloudflareBindings } from "../src/types";
import type { UsageService } from "../src/usage";

const MODEL_ID = "provider/coding-model";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const KEY_ID = "00000000-0000-4000-8000-000000000002";
const USAGE_ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const ROTATED_KEY_ID = "00000000-0000-4000-8000-000000000004";
const TEAM_ID = "00000000-0000-4000-8000-000000000005";
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
		SENKO_INFERENCE_ENABLED: "true",
		SENKO_MODELS: JSON.stringify([
			{
				context_window: 131_072,
				id: MODEL_ID,
				input_modalities: ["text"],
				max_output_tokens: 16_384,
				pricing: {
					currency: "USD",
					input_microunits_per_million_tokens: 2_000_000,
					output_microunits_per_million_tokens: 8_000_000,
					version: "pricing-1",
				},
				reasoning: true,
				supported_protocols: ["openai-completions", "openai-responses"],
			},
		]),
		SENKO_PROVIDER_KEY_OPENAI: "llm-secret",
		SENKO_PROVIDER_POOLS: {
			getByName() {
				return {
					async fetch(input: RequestInfo | URL, init?: RequestInit) {
						const request = input instanceof Request ? input : new Request(input, init);
						const path = new URL(request.url).pathname;
						const body = (await request.json()) as { leaseId: string };
						if (path === "/acquire") {
							return Response.json({
								circuitOpenUntil: 0,
								leaseExpiresAt: Date.now() + 90_000,
								leaseId: body.leaseId,
								ok: true,
								remainingConcurrentRequests: 9,
								remainingRequests: 119,
								remainingTokens: 199_000,
								resetSeconds: 60,
							});
						}
						if (path === "/renew") return Response.json({ leaseExpiresAt: Date.now() + 90_000 });
						return Response.json({ circuitOpenUntil: 0, consecutiveFailures: 0, released: true });
					},
				};
			},
		} as unknown as DurableObjectNamespace,
		SENKO_PROVIDER_ROUTES: JSON.stringify([
			{
				capacity: { max_concurrent_requests: 10, requests_per_minute: 120, tokens_per_minute: 200_000 },
				destination: "openai",
				id: "primary",
				models: { [MODEL_ID]: MODEL_ID },
				priority: 0,
				supported_protocols: ["openai-completions", "openai-responses"],
			},
		]),
		...overrides,
	};
}

function completedResponse(options: { id?: string; inputTokens?: number; outputTokens?: number } = {}) {
	return {
		created_at: 1,
		id: options.id ?? "resp_test",
		model: MODEL_ID,
		object: "response",
		output: [],
		status: "completed",
		usage: {
			input_tokens: options.inputTokens ?? 4,
			output_tokens: options.outputTokens ?? 2,
			total_tokens: (options.inputTokens ?? 4) + (options.outputTokens ?? 2),
		},
	};
}

function usage(overrides: Partial<UsageService> = {}): UsageService {
	return {
		async configureApiKeyLimits(_env, input) {
			return { ok: true, value: input };
		},
		async configureLimits(_env, input) {
			return { ok: true, value: input };
		},
		async finalize() {
			return { ok: true, value: { overLimitAfterSettlement: false, settledCostMicrounits: 100 } };
		},
		async reconcileExpired() {
			return { ok: true, value: { candidates: 0, failed: 0, settled: 0, skipped: 0 } };
		},
		async reserve(_env, input) {
			return {
				ok: true,
				value: {
					accountId: input.accountId,
					attemptId: USAGE_ATTEMPT_ID,
					requestId: input.requestId,
					reservedCostMicrounits: 100,
				},
			};
		},
		...overrides,
	};
}

function allowingAdmission(): AdmissionClient {
	return {
		async acquire(_env, _accountId, _keyId, leaseId) {
			return { leaseExpiresAt: Date.now() + 90_000, leaseId, ok: true, rateLimit: RATE_LIMIT };
		},
		async release() {
			return true;
		},
		async renew() {
			return { leaseExpiresAt: Date.now() + 90_000, ok: true };
		},
	};
}

function inferenceIdentity(): IdentityService {
	return identity({
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
	});
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
					suspendedAt: null,
				},
			};
		},
		async createTeam() {
			return {
				ok: true,
				value: {
					accountId: ACCOUNT_ID,
					createdAt: "2026-08-24T00:00:00.000Z",
					id: TEAM_ID,
					name: "Platform",
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
					lastUsedAt: null,
					name: "CLI",
					publicId: "public-key-id",
					replacesApiKeyId: null,
					revokedAt: null,
					rotationGroupId: KEY_ID,
					scopes: ["models:read"],
					status: "active",
					teamId: null,
				},
			};
		},
		async listAccounts() {
			return {
				ok: true,
				value: {
					data: [
						{
							createdAt: "2026-08-24T00:00:00.000Z",
							id: ACCOUNT_ID,
							name: "Test account",
							planKey: "beta",
							status: "active",
							suspendedAt: null,
						},
					],
					hasMore: false,
				},
			};
		},
		async listAuditEvents() {
			return {
				ok: true,
				value: {
					data: [
						{
							accountId: ACCOUNT_ID,
							action: "team.archived",
							actorType: "system",
							createdAt: "2026-08-24T00:03:00.000Z",
							id: TEAM_ID,
							requestId: "req_00000000000000000000000000000000",
							targetId: TEAM_ID,
							targetType: "team",
						},
					],
					hasMore: false,
				},
			};
		},
		async listApiKeys() {
			return {
				ok: true,
				value: {
					data: [
						{
							accountId: ACCOUNT_ID,
							createdAt: "2026-08-24T00:00:00.000Z",
							expiresAt: null,
							id: KEY_ID,
							keyPrefix: "sk-senko-v1-public",
							lastUsedAt: null,
							name: "CLI",
							publicId: "public-key-id",
							replacesApiKeyId: null,
							revokedAt: null,
							rotationGroupId: KEY_ID,
							scopes: ["models:read"],
							status: "active",
							teamId: null,
						},
					],
					hasMore: false,
				},
			};
		},
		async listTeams() {
			return {
				ok: true,
				value: {
					data: [
						{
							accountId: ACCOUNT_ID,
							createdAt: "2026-08-24T00:00:00.000Z",
							id: TEAM_ID,
							name: "Platform",
							status: "active",
						},
					],
					hasMore: false,
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
					lastUsedAt: null,
					name: "CLI",
					publicId: "public-key-id",
					replacesApiKeyId: null,
					revokedAt: "2026-08-24T00:01:00.000Z",
					rotationGroupId: KEY_ID,
					scopes: ["models:read"],
					status: "revoked",
					teamId: null,
				},
			};
		},
		async rotateApiKey() {
			return {
				ok: true,
				value: {
					accountId: ACCOUNT_ID,
					createdAt: "2026-08-24T00:01:00.000Z",
					expiresAt: null,
					id: ROTATED_KEY_ID,
					key: "sk-senko-v1-rotated-secret",
					keyPrefix: "sk-senko-v1-rotated",
					lastUsedAt: null,
					name: "CLI rotated",
					publicId: "rotated-public-id",
					replacesApiKeyId: KEY_ID,
					revokedAt: null,
					rotationGroupId: KEY_ID,
					scopes: ["models:read"],
					status: "active",
					teamId: null,
				},
			};
		},
		async setAccountStatus(_env, input) {
			return {
				ok: true,
				value: {
					createdAt: "2026-08-24T00:00:00.000Z",
					id: ACCOUNT_ID,
					name: "Test account",
					planKey: "beta",
					status: input.status,
					suspendedAt: input.status === "suspended" ? "2026-08-24T00:02:00.000Z" : null,
				},
			};
		},
		async setTeamStatus(_env, input) {
			return {
				ok: true,
				value: {
					accountId: ACCOUNT_ID,
					createdAt: "2026-08-24T00:00:00.000Z",
					id: TEAM_ID,
					name: "Platform",
					status: input.status,
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
	it("protects dependency health and returns only bounded check statuses", async () => {
		const check = vi.fn().mockResolvedValue({
			checks: {
				admission: "ok",
				configuration: "ok",
				identity_storage: "ok",
				provider_capacity: "ok",
				usage_ledger: "ok",
			},
			status: "ok",
		});
		const app = createApp({ dependencyHealthService: { check } });
		const unauthorized = await app.request("/admin/v1/dependency-health", {}, env());
		expect(unauthorized.status).toBe(401);
		expect(check).not.toHaveBeenCalled();

		const response = await app.request(
			"/admin/v1/dependency-health",
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			checks: {
				admission: "ok",
				configuration: "ok",
				identity_storage: "ok",
				provider_capacity: "ok",
				usage_ledger: "ok",
			},
			object: "dependency_health",
			status: "ok",
		});
	});

	it("protects content-free support lookup and returns only bounded request metadata", async () => {
		const lookupRequest = vi.fn<SupportService["lookupRequest"]>().mockResolvedValue({
			ok: true,
			value: {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				attempts: [
					{
						accountId: ACCOUNT_ID,
						apiKeyId: KEY_ID,
						attemptId: USAGE_ATTEMPT_ID,
						createdAt: "2026-08-24T00:00:00.000Z",
						currency: "USD",
						estimatedInputTokens: 4,
						ledger: [],
						pendingReservation: false,
						policyVersion: "policy-1",
						pricingVersion: "pricing-1",
						protocol: "openai-responses",
						providerAttempt: 0,
						providerRoute: "primary",
						requestedModel: "fast",
						reservationExpiresAt: "2026-08-24T00:02:00.000Z",
						reservedCostMicrounits: 100,
						reservedOutputTokens: 16,
						resolvedModel: MODEL_ID,
					},
				],
				completedAt: "2026-08-24T00:01:00.000Z",
				endpoint: "responses",
				failureCategory: null,
				hasMore: false,
				httpStatus: 200,
				method: "POST",
				requestId: "req_00000000000000000000000000000001",
				startedAt: "2026-08-24T00:00:00.000Z",
			},
		});
		const app = createApp({
			supportService: {
				lookupRequest,
				async recordRequest() {
					return { ok: true, value: undefined };
				},
			},
		});
		const unauthorized = await app.request("/admin/v1/requests/req_00000000000000000000000000000001", {}, env());
		expect(unauthorized.status).toBe(401);
		expect(lookupRequest).not.toHaveBeenCalled();

		const response = await app.request(
			"/admin/v1/requests/req_00000000000000000000000000000001",
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json();
		expect(body).toMatchObject({
			account_id: ACCOUNT_ID,
			api_key_id: KEY_ID,
			attempts: [{ account_id: ACCOUNT_ID, api_key_id: KEY_ID, attempt_id: USAGE_ATTEMPT_ID }],
			failure_category: null,
			has_more: false,
			http_status: 200,
			object: "request_trace",
			request_id: "req_00000000000000000000000000000001",
		});
		const keys = JSON.stringify(body);
		expect(keys).not.toContain("prompt");
		expect(keys).not.toContain("messages");
		expect(keys).not.toContain("authorization");
		expect(lookupRequest).toHaveBeenCalledWith(expect.any(Object), "req_00000000000000000000000000000001");
	});

	it("rejects malformed support request IDs before storage lookup", async () => {
		const lookupRequest = vi.fn<SupportService["lookupRequest"]>();
		const app = createApp({
			supportService: {
				lookupRequest,
				async recordRequest() {
					return { ok: true, value: undefined };
				},
			},
		});
		const response = await app.request(
			"/admin/v1/requests/customer-chosen-id",
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_request_id", param: "requestId" } });
		expect(lookupRequest).not.toHaveBeenCalled();
	});

	it("persists a failed request envelope before usage reservation exists", async () => {
		const background: Promise<unknown>[] = [];
		const recordRequest = vi.fn<SupportService["recordRequest"]>().mockResolvedValue({ ok: true, value: undefined });
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			supportService: {
				async lookupRequest() {
					return { ok: false, reason: "not_found" };
				},
				recordRequest,
			},
			usageService: usage({
				async reserve() {
					return { ok: false, reason: "unconfigured" };
				},
			}),
		});
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: MODEL_ID }),
				headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
				method: "POST",
			},
			env({
				SENKO_API_KEY_HASH_SECRET_V1: "test-hash-secret-that-is-at-least-32-bytes-long",
				SENKO_DATABASE_URL:
					"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require",
			}),
			{
				waitUntil(promise: Promise<unknown>) {
					background.push(promise);
				},
			} as unknown as ExecutionContext,
		);
		expect(response.status).toBe(503);
		await Promise.all(background);
		expect(recordRequest).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				endpoint: "responses",
				failureCategory: "usage",
				httpStatus: 503,
				method: "POST",
				requestId: expect.stringMatching(/^req_[a-f0-9]{32}$/),
			}),
		);
	});

	it("does not create support-database writes for unauthenticated traffic", async () => {
		const recordRequest = vi.fn<SupportService["recordRequest"]>();
		const app = createApp({
			identityService: identity({
				async authenticate() {
					return { ok: false, reason: "not_found" };
				},
			}),
			supportService: {
				async lookupRequest() {
					return { ok: false, reason: "not_found" };
				},
				recordRequest,
			},
		});
		const response = await app.request(
			"/v1/models",
			{},
			env({
				SENKO_API_KEY_HASH_SECRET_V1: "test-hash-secret-that-is-at-least-32-bytes-long",
				SENKO_DATABASE_URL:
					"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require",
			}),
		);
		expect(response.status).toBe(401);
		expect(recordRequest).not.toHaveBeenCalled();
	});

	it("does not persist request traces for authenticated model discovery", async () => {
		const recordRequest = vi.fn<SupportService["recordRequest"]>();
		const touchLastUsed = vi.fn<IdentityService["touchLastUsed"]>().mockResolvedValue({ ok: true, value: undefined });
		const waitUntil = vi.fn();
		const app = createApp({
			identityService: identity({ touchLastUsed }),
			supportService: {
				async lookupRequest() {
					return { ok: false, reason: "not_found" };
				},
				recordRequest,
			},
		});
		const response = await app.request(
			"/v1/models",
			{ headers: { authorization: "Bearer managed-key" } },
			env({
				SENKO_API_KEY_HASH_SECRET_V1: "test-hash-secret-that-is-at-least-32-bytes-long",
				SENKO_DATABASE_URL:
					"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require",
			}),
			{ waitUntil } as unknown as ExecutionContext,
		);

		expect(response.status).toBe(200);
		expect(recordRequest).not.toHaveBeenCalled();
		expect(touchLastUsed).toHaveBeenCalledWith(expect.any(Object), KEY_ID);
		expect(waitUntil).toHaveBeenCalledOnce();
	});

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
			llmApiFetch: async () => Response.json(completedResponse()),
			usageService: usage(),
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

	it("reserves and settles database-authenticated inference against the account", async () => {
		const reserve = vi.fn<UsageService["reserve"]>(usage().reserve);
		const finalize = vi.fn<UsageService["finalize"]>(usage().finalize);
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: async () => Response.json(completedResponse({ inputTokens: 12, outputTokens: 3 })),
			usageService: usage({ finalize, reserve }),
		});
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", max_output_tokens: 10, model: MODEL_ID }),
				headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(200);
		expect(reserve).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				providerAttempt: 0,
				requestedModel: MODEL_ID,
				reservedOutputTokens: 10,
			}),
		);
		expect(finalize).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				accountId: ACCOUNT_ID,
				attemptId: USAGE_ATTEMPT_ID,
				kind: "settled",
				usage: { inputTokens: 12, outputTokens: 3 },
			}),
		);
	});

	it("settles terminal stream usage when the client cancels before provider EOF", async () => {
		const finalize = vi.fn<UsageService["finalize"]>(usage().finalize);
		const providerRelease = vi.fn<ProviderPoolClient["release"]>(async () => ({
			circuitOpenUntil: 0,
			consecutiveFailures: 0,
			released: true,
		}));
		const providerPoolClient: ProviderPoolClient = {
			async acquire(_env, _routeId, _capacity, leaseId) {
				return {
					circuitOpenUntil: 0,
					leaseExpiresAt: Date.now() + 90_000,
					leaseId,
					ok: true,
					remainingConcurrentRequests: 9,
					remainingRequests: 119,
					remainingTokens: 199_000,
					resetSeconds: 60,
				};
			},
			release: providerRelease,
			async renew() {
				return { leaseExpiresAt: Date.now() + 90_000, ok: true };
			},
		};
		const terminal = `event: response.completed\ndata: ${JSON.stringify({
			response: completedResponse({ inputTokens: 12, outputTokens: 3 }),
			sequence_number: 1,
			type: "response.completed",
		})}\n\n`;
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(terminal));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			providerPoolClient,
			usageService: usage({ finalize }),
		});
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: MODEL_ID, stream: true }),
				headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
				method: "POST",
			},
			env(),
		);
		const reader = response.body?.getReader();
		const event = await reader?.read();
		expect(new TextDecoder().decode(event?.value)).toContain("response.completed");
		await reader?.cancel("terminal received");

		await vi.waitFor(() =>
			expect(finalize).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					kind: "settled",
					terminalReason: "completed",
					usage: { inputTokens: 12, outputTokens: 3 },
				}),
			),
		);
		expect(providerRelease).toHaveBeenCalledWith(expect.anything(), "primary", expect.any(String), "succeeded");
	});

	it("fails closed before provider forwarding when account usage limits are missing", async () => {
		const llmApi = vi.fn();
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: llmApi,
			usageService: usage({
				async reserve() {
					return { ok: false, reason: "unconfigured" };
				},
			}),
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
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "usage_limits_unconfigured" } });
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("fails closed when database-mode model pricing is not configured", async () => {
		const reserve = vi.fn<UsageService["reserve"]>(usage().reserve);
		const llmApi = vi.fn();
		const modelsWithoutPricing = JSON.stringify([
			{
				context_window: 131_072,
				id: MODEL_ID,
				input_modalities: ["text"],
				max_output_tokens: 16_384,
				reasoning: true,
				supported_protocols: ["openai-responses"],
			},
		]);
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: llmApi,
			usageService: usage({ reserve }),
		});
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: MODEL_ID }),
				headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
				method: "POST",
			},
			env({ SENKO_MODELS: modelsWithoutPricing }),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "configuration_error", message: expect.stringContaining("pricing") },
		});
		expect(reserve).not.toHaveBeenCalled();
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("rejects a successful response that omits terminal usage and conservatively settles it", async () => {
		const finalize = vi.fn<UsageService["finalize"]>(usage().finalize);
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: async () =>
				Response.json({
					created_at: 1,
					id: "resp_without_usage",
					model: MODEL_ID,
					object: "response",
					output: [],
					status: "completed",
				}),
			operationalLogger: { emit },
			usageService: usage({ finalize }),
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
		expect(response.status).toBe(502);
		expect(finalize).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ kind: "conservative_settled", terminalReason: "invalid_provider_response" }),
		);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "usage_settlement_completed",
				settlement_kind: "conservative_settled",
				terminal_reason: "invalid_provider_response",
			}),
		);
	});

	it("conservatively settles a stream that ends before a protocol terminal event", async () => {
		const finalize = vi.fn<UsageService["finalize"]>(usage().finalize);
		const recordRequest = vi.fn<SupportService["recordRequest"]>().mockResolvedValue({ ok: true, value: undefined });
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: async () =>
				new Response(
					`event: response.in_progress\ndata: ${JSON.stringify({
						response: {
							created_at: 1,
							id: "resp_in_progress",
							model: MODEL_ID,
							object: "response",
							output: [],
							status: "in_progress",
						},
						sequence_number: 1,
						type: "response.in_progress",
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
			supportService: {
				async lookupRequest() {
					return { ok: false, reason: "not_found" };
				},
				recordRequest,
			},
			usageService: usage({ finalize }),
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const response = await app.request(
				"/v1/responses",
				{
					body: JSON.stringify({ input: "hello", model: MODEL_ID, stream: true }),
					headers: { authorization: "Bearer managed-key", "content-type": "application/json" },
					method: "POST",
				},
				env({
					SENKO_API_KEY_HASH_SECRET_V1: "test-hash-secret-that-is-at-least-32-bytes-long",
					SENKO_DATABASE_URL:
						"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require",
				}),
				{ waitUntil() {} } as unknown as ExecutionContext,
			);
			expect(response.status).toBe(200);
			expect(recordRequest).not.toHaveBeenCalled();
			await expect(response.text()).rejects.toThrow("invalid provider response");
			expect(finalize).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({ kind: "conservative_settled", terminalReason: "invalid_provider_stream" }),
			);
			await vi.waitFor(() =>
				expect(recordRequest).toHaveBeenCalledWith(
					expect.any(Object),
					expect.objectContaining({
						accountId: ACCOUNT_ID,
						apiKeyId: KEY_ID,
						failureCategory: "provider_protocol",
						httpStatus: 200,
					}),
				),
			);
		} finally {
			warning.mockRestore();
		}
	});

	it.each([
		{
			name: "a complete provider error response",
			response: () =>
				Response.json(
					{ error: { code: "provider_failure", message: "provider failed", type: "server_error" } },
					{ status: 500 },
				),
		},
		{
			name: "a provider error response whose body is interrupted",
			response: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"error":'));
							controller.error(new Error("provider body interrupted"));
						},
					}),
					{ headers: { "content-type": "application/json" }, status: 502 },
				),
		},
	])("conservatively settles $name because provider cost is unknown", async ({ response: providerResponse }) => {
		const finalize = vi.fn<UsageService["finalize"]>(usage().finalize);
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = createApp({
			admissionClient: allowingAdmission(),
			identityService: inferenceIdentity(),
			llmApiFetch: async () => providerResponse(),
			operationalLogger: { emit },
			usageService: usage({ finalize }),
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
		expect(response.status).toBe(502);
		expect(finalize).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				kind: "conservative_settled",
				terminalReason: "provider_rejected_unknown_cost",
			}),
		);
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "usage_settlement_completed",
				settlement_kind: "conservative_settled",
				terminal_reason: "provider_rejected_unknown_cost",
			}),
		);
	});

	it("returns a safe 503 when identity storage is unavailable", async () => {
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = createApp({
			identityService: identity({
				async authenticate() {
					return { ok: false, reason: "unavailable" };
				},
			}),
			operationalLogger: { emit },
		});
		const response = await app.request("/v1/models", { headers: { authorization: "Bearer managed-key" } }, env());
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "identity_unavailable" } });
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ event: "identity_backend_operation", terminal_reason: "unavailable" }),
		);
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

	it("creates an account-owned team through the protected management boundary", async () => {
		const createTeam = vi.fn<IdentityService["createTeam"]>(identity().createTeam);
		const app = createApp({ identityService: identity({ createTeam }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/teams`,
			{
				body: JSON.stringify({ name: "Platform" }),
				headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			account_id: ACCOUNT_ID,
			created_at: "2026-08-24T00:00:00.000Z",
			id: TEAM_ID,
			name: "Platform",
			object: "team",
			status: "active",
		});
		expect(createTeam).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, name: "Platform", requestId: expect.any(String) }),
		);
	});

	it("lists bounded account metadata through the protected management boundary", async () => {
		const listAccounts = vi.fn<IdentityService["listAccounts"]>(identity().listAccounts);
		const app = createApp({ identityService: identity({ listAccounts }) });
		const response = await app.request(
			`/admin/v1/accounts?limit=25&starting_after=${ACCOUNT_ID}`,
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			data: [
				{
					created_at: "2026-08-24T00:00:00.000Z",
					id: ACCOUNT_ID,
					name: "Test account",
					object: "account",
					plan_key: "beta",
					status: "active",
					suspended_at: null,
				},
			],
			has_more: false,
			next_starting_after: null,
			object: "list",
		});
		expect(listAccounts).toHaveBeenCalledWith(expect.any(Object), {
			limit: 25,
			startingAfter: ACCOUNT_ID,
		});
	});

	it("lists only content-free account audit metadata", async () => {
		const listAuditEvents = vi.fn<IdentityService["listAuditEvents"]>(identity().listAuditEvents);
		const app = createApp({ identityService: identity({ listAuditEvents }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/audit-events?limit=25&starting_after=${TEAM_ID}`,
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json<Record<string, unknown>>();
		expect(body).toEqual({
			data: [
				{
					account_id: ACCOUNT_ID,
					action: "team.archived",
					actor_type: "system",
					created_at: "2026-08-24T00:03:00.000Z",
					id: TEAM_ID,
					object: "audit_event",
					request_id: "req_00000000000000000000000000000000",
					target_id: TEAM_ID,
					target_type: "team",
				},
			],
			has_more: false,
			next_starting_after: null,
			object: "list",
		});
		expect(JSON.stringify(body)).not.toContain("metadata");
		expect(listAuditEvents).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, limit: 25, startingAfter: TEAM_ID }),
		);
	});

	it("lists only account-owned team metadata with bounded pagination", async () => {
		const listTeams = vi.fn<IdentityService["listTeams"]>(identity().listTeams);
		const app = createApp({ identityService: identity({ listTeams }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/teams?limit=25&starting_after=${TEAM_ID}`,
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			data: [
				{
					account_id: ACCOUNT_ID,
					created_at: "2026-08-24T00:00:00.000Z",
					id: TEAM_ID,
					name: "Platform",
					object: "team",
					status: "active",
				},
			],
			has_more: false,
			next_starting_after: null,
			object: "list",
		});
		expect(listTeams).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, limit: 25, startingAfter: TEAM_ID }),
		);
	});

	it.each([
		["archive", "archived"],
		["reactivate", "active"],
	] as const)("changes team state through the protected %s endpoint", async (action, status) => {
		const setTeamStatus = vi.fn<IdentityService["setTeamStatus"]>(identity().setTeamStatus);
		const app = createApp({ identityService: identity({ setTeamStatus }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/teams/${TEAM_ID}/${action}`,
			{
				headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({ account_id: ACCOUNT_ID, id: TEAM_ID, object: "team", status });
		expect(setTeamStatus).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, requestId: expect.any(String), status, teamId: TEAM_ID }),
		);
	});

	it.each([
		["suspend", "suspended", "2026-08-24T00:02:00.000Z"],
		["reactivate", "active", null],
	] as const)("changes account state through the protected %s endpoint", async (action, status, suspendedAt) => {
		const setAccountStatus = vi.fn<IdentityService["setAccountStatus"]>(identity().setAccountStatus);
		const app = createApp({ identityService: identity({ setAccountStatus }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/${action}`,
			{
				headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			id: ACCOUNT_ID,
			object: "account",
			status,
			suspended_at: suspendedAt,
		});
		expect(setAccountStatus).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, requestId: expect.any(String), status }),
		);
	});

	it("lists only account-owned API key metadata with bounded pagination", async () => {
		const listApiKeys = vi.fn<IdentityService["listApiKeys"]>(identity().listApiKeys);
		const app = createApp({ identityService: identity({ listApiKeys }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/api-keys?limit=25&starting_after=${ROTATED_KEY_ID}`,
			{ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
			env(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.json();
		expect(body).toMatchObject({ data: [{ account_id: ACCOUNT_ID, id: KEY_ID }], has_more: false, object: "list" });
		expect(JSON.stringify(body)).not.toContain("sk-senko-v1-public-secret");
		expect(listApiKeys).toHaveBeenCalledWith(expect.any(Object), {
			accountId: ACCOUNT_ID,
			limit: 25,
			startingAfter: ROTATED_KEY_ID,
		});
	});

	it("issues an overlapping replacement and keeps revocation separate", async () => {
		const rotateApiKey = vi.fn<IdentityService["rotateApiKey"]>(identity().rotateApiKey);
		const app = createApp({ identityService: identity({ rotateApiKey }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/api-keys/${KEY_ID}/rotate`,
			{
				body: JSON.stringify({ name: "CLI next" }),
				headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			id: ROTATED_KEY_ID,
			key: "sk-senko-v1-rotated-secret",
			replaces_api_key_id: KEY_ID,
			status: "active",
			warning: expect.stringContaining("remains active until revoked"),
		});
		expect(rotateApiKey).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, keyId: KEY_ID, name: "CLI next" }),
		);
	});

	it("configures explicit account usage limits through the protected management API", async () => {
		const configureLimits = vi.fn<UsageService["configureLimits"]>(usage().configureLimits);
		const app = createApp({ identityService: identity(), usageService: usage({ configureLimits }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/usage-limits`,
			{
				body: JSON.stringify({
					currency: "USD",
					daily_cost_microunits: 10_000_000,
					max_request_cost_microunits: 1_000_000,
					minute_input_tokens: 100_000,
					minute_output_tokens: 20_000,
					monthly_cost_microunits: 100_000_000,
					policy_version: "beta-1",
				}),
				headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
				method: "PUT",
			},
			env(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ account_id: ACCOUNT_ID, policy_version: "beta-1" });
		expect(configureLimits).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ accountId: ACCOUNT_ID, currency: "USD", requestId: expect.any(String) }),
		);
	});

	it("configures narrower API key usage limits through the protected management API", async () => {
		const configureApiKeyLimits = vi.fn<UsageService["configureApiKeyLimits"]>(usage().configureApiKeyLimits);
		const app = createApp({ identityService: identity(), usageService: usage({ configureApiKeyLimits }) });
		const response = await app.request(
			`/admin/v1/accounts/${ACCOUNT_ID}/api-keys/${KEY_ID}/usage-limits`,
			{
				body: JSON.stringify({
					currency: "USD",
					daily_cost_microunits: 5_000_000,
					max_request_cost_microunits: 500_000,
					minute_input_tokens: 50_000,
					minute_output_tokens: 10_000,
					monthly_cost_microunits: 50_000_000,
					policy_version: "key-beta-1",
				}),
				headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
				method: "PUT",
			},
			env(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			account_id: ACCOUNT_ID,
			api_key_id: KEY_ID,
			object: "api_key_usage_limits",
			policy_version: "key-beta-1",
		});
		expect(configureApiKeyLimits).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				currency: "USD",
				requestId: expect.any(String),
			}),
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
