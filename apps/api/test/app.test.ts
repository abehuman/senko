import { describe, expect, it, vi } from "vitest";
import type { AdmissionClient } from "../src/admission";
import {
	type AdmissionRateLimit,
	LEASE_RENEW_INTERVAL_MS,
	LEASE_RENEW_RETRY_INTERVAL_MS,
	LEASE_TTL_MS,
} from "../src/admission-state";
import { createApp, MAX_OUTPUT_TOKENS_PER_REQUEST } from "../src/app";
import { MAX_REQUEST_BODY_BYTES } from "../src/body";
import type { CloudflareBindings, LlmApiFetch } from "../src/types";

const MODEL_ID = "provider/coding-model";
const TEST_LEASE_EXPIRES_AT = Date.now() + 10 * 60_000;

const RATE_LIMIT: AdmissionRateLimit = {
	limitConcurrentRequests: 2,
	limitRequests: 20,
	remainingConcurrentRequests: 1,
	remainingRequests: 19,
	resetSeconds: 60,
};

const allowingAdmissionClient: AdmissionClient = {
	async acquire(_env, _accountId, _keyId, leaseId) {
		return { leaseExpiresAt: TEST_LEASE_EXPIRES_AT, leaseId, ok: true, rateLimit: RATE_LIMIT };
	},
	async release() {
		return true;
	},
	async renew() {
		return { leaseExpiresAt: Date.now() + LEASE_TTL_MS, ok: true };
	},
};

function testApp(options: NonNullable<Parameters<typeof createApp>[0]> = {}) {
	return createApp({ admissionClient: allowingAdmissionClient, ...options });
}

function env(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
		SENKO_AUTH_MODE: "bootstrap",
		SENKO_API_KEYS: "test-key,second-key",
		SENKO_FAST_MODEL: MODEL_ID,
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
		LLM_API_BASE_URL: "https://llm.example/v1/",
		LLM_API_KEY: "llm-secret",
		...overrides,
	};
}

function authHeaders(): HeadersInit {
	return { authorization: "Bearer test-key", "content-type": "application/json" };
}

describe("Senko API Worker", () => {
	it("serves public root and health endpoints", async () => {
		const app = testApp();
		await expect((await app.request("/health")).json()).resolves.toEqual({ status: "ok" });
		await expect((await app.request("/")).json()).resolves.toEqual({ name: "Senko API", status: "ok" });
	});

	it("requires a configured API key secret", async () => {
		const app = testApp();
		const response = await app.request("/v1/models", {}, env({ SENKO_API_KEYS: undefined }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
	});

	it("requires an explicit authentication mode instead of silently falling back", async () => {
		const app = testApp();
		const response = await app.request("/v1/models", {}, env({ SENKO_AUTH_MODE: undefined }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "configuration_error", message: expect.stringContaining("SENKO_AUTH_MODE") },
		});
	});

	it("returns the same authentication error for missing and invalid keys", async () => {
		const app = testApp();
		const missing = await app.request("/v1/models", {}, env());
		const invalid = await app.request("/v1/models", { headers: { authorization: "Bearer wrong" } }, env());
		expect(missing.status).toBe(401);
		expect(invalid.status).toBe(401);
		expect(await missing.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(await invalid.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(missing.headers.get("x-request-id")).toMatch(/^req_[a-f0-9]{32}$/);
	});

	it("lists the fast alias and curated model metadata", async () => {
		const app = testApp();
		const response = await app.request("/v1/models", { headers: authHeaders() }, env());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: [
				expect.objectContaining({ id: "fast", reasoning: true, resolved_model: MODEL_ID }),
				expect.objectContaining({ context_window: 131_072, id: MODEL_ID, max_output_tokens: 16_384 }),
			],
			object: "list",
		});
	});

	it("returns actionable model configuration errors", async () => {
		const app = testApp();
		const response = await app.request("/v1/models", { headers: authHeaders() }, env({ SENKO_MODELS: "[]" }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "configuration_error", message: expect.stringContaining("at least one") },
		});
	});

	it("resolves fast and streams Chat Completions responses", async () => {
		const llmApi = vi.fn<LlmApiFetch>(async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body.model).toBe(MODEL_ID);
			expect(body.max_completion_tokens).toBe(MAX_OUTPUT_TOKENS_PER_REQUEST);
			expect(body.n).toBe(1);
			expect(body.store).toBe(false);
			expect(body.stream_options).toEqual({ include_usage: true });
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer llm-secret");
			expect(new Headers(init?.headers).has("openai-organization")).toBe(false);
			expect(new Headers(init?.headers).has("openai-project")).toBe(false);
			return new Response(`data: {"model":"${MODEL_ID}"}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream", "x-ratelimit-remaining-requests": "9" },
			});
		});
		const app = testApp({ llmApiFetch: llmApi });
		const response = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [], model: "fast", stream: true }),
				headers: {
					authorization: "Bearer test-key",
					"content-type": "application/json",
					"openai-organization": "client-org",
					"openai-project": "client-project",
				},
				method: "POST",
			},
			env(),
		);
		expect(llmApi).toHaveBeenCalledWith("https://llm.example/v1/chat/completions", expect.any(Object));
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("x-ratelimit-limit-requests")).toBe("20");
		expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("19");
		expect(await response.text()).toContain("data: [DONE]");
	});

	it("forwards Responses requests to the Responses endpoint", async () => {
		const llmApi = vi.fn<LlmApiFetch>(async (_input, init) => {
			expect(JSON.parse(String(init?.body)).max_output_tokens).toBe(MAX_OUTPUT_TOKENS_PER_REQUEST);
			return Response.json({ id: "resp_test", model: MODEL_ID, object: "response" });
		});
		const app = testApp({ llmApiFetch: llmApi });
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: MODEL_ID }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(200);
		expect(llmApi.mock.calls[0]?.[0]).toBe("https://llm.example/v1/responses");
	});

	it("rejects malformed JSON and unavailable models before calling the LLM API", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const app = testApp({ llmApiFetch: llmApi });
		const malformed = await app.request(
			"/v1/chat/completions",
			{ body: "{", headers: authHeaders(), method: "POST" },
			env(),
		);
		const invalidModel = await app.request(
			"/v1/chat/completions",
			{ body: JSON.stringify({ model: "not-curated" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(malformed.status).toBe(400);
		expect(invalidModel.status).toBe(400);
		expect(await invalidModel.json()).toMatchObject({ error: { code: "invalid_model", param: "model" } });
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("rejects requests that exceed output-token or choice-count ceilings", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const app = testApp({ llmApiFetch: llmApi });
		const excessiveTokens = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", max_output_tokens: MAX_OUTPUT_TOKENS_PER_REQUEST + 1, model: "fast" }),
				headers: authHeaders(),
				method: "POST",
			},
			env(),
		);
		const excessiveChoices = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [], model: "fast", n: 2 }),
				headers: authHeaders(),
				method: "POST",
			},
			env(),
		);
		expect(excessiveTokens.status).toBe(400);
		expect(await excessiveTokens.json()).toMatchObject({ error: { code: "invalid_max_output_tokens" } });
		expect(excessiveChoices.status).toBe(400);
		expect(await excessiveChoices.json()).toMatchObject({ error: { code: "unsupported_choice_count" } });
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("rejects unknown, stateful, hosted-tool, and provider-file request features", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const app = testApp({ llmApiFetch: llmApi });
		const requests = [
			{
				body: { messages: [], model: "fast", service_tier: "priority" },
				code: "unsupported_parameter",
				path: "/v1/chat/completions",
			},
			{
				body: { background: true, input: "hello", model: "fast" },
				code: "unsupported_background_request",
				path: "/v1/responses",
			},
			{
				body: { messages: [], model: "fast", tools: [{ type: "web_search" }] },
				code: "unsupported_tool",
				path: "/v1/chat/completions",
			},
			{
				body: {
					input: [{ content: [{ file_id: "file_secret", type: "input_file" }], role: "user" }],
					model: "fast",
				},
				code: "unsupported_file_input",
				path: "/v1/responses",
			},
		];
		for (const request of requests) {
			const response = await app.request(
				request.path,
				{ body: JSON.stringify(request.body), headers: authHeaders(), method: "POST" },
				env(),
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: request.code } });
		}
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("normalizes non-compatible LLM API errors", async () => {
		const app = testApp({
			llmApiFetch: async () => new Response("provider exploded", { status: 429 }),
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({ error: { code: "llm_api_error" } });
	});

	it("rebuilds provider errors and exposes only Senko rate-limit metadata", async () => {
		const app = testApp({
			llmApiFetch: async () =>
				Response.json(
					{
						debug: "provider-internal",
						error: {
							code: "context_length_exceeded",
							message: "The request exceeded the context window.",
							metadata: { internal: "provider-internal" },
							param: "input",
							type: "invalid_request_error",
						},
					},
					{
						headers: { "retry-after": "3", "x-ratelimit-remaining-requests": "0" },
						status: 400,
					},
				),
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(400);
		const responseBody = await response.json();
		expect(responseBody).toEqual({
			error: {
				code: "context_length_exceeded",
				message: "The request exceeded the context window.",
				param: "input",
				type: "invalid_request_error",
			},
		});
		expect(response.headers.get("retry-after")).toBe("3");
		expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("19");
		expect(JSON.stringify(responseBody)).not.toContain("provider-internal");
	});

	it("drops unsafe provider error fields", async () => {
		const app = testApp({
			llmApiFetch: async () =>
				Response.json(
					{
						error: {
							code: "invalid request\nsecret",
							message: "Invalid input.\u0000 Try again.",
							param: "input\r\nx-provider-secret",
							type: "invalid request",
						},
					},
					{ status: 400 },
				),
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(await response.json()).toEqual({
			error: {
				code: "llm_api_error",
				message: "Invalid input.  Try again.",
				param: null,
				type: "llm_api_error",
			},
		});
	});

	it("does not expose LLM API authentication errors", async () => {
		const app = testApp({
			llmApiFetch: async () => Response.json({ error: { message: "Incorrect API key llm-secret" } }, { status: 401 }),
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(502);
		expect(JSON.stringify(await response.json())).not.toContain("llm-secret");
	});

	it("maps LLM API network failures to a safe error", async () => {
		const app = testApp({
			llmApiFetch: async () => {
				throw new Error("secret network detail");
			},
		});
		const response = await app.request(
			"/v1/chat/completions",
			{ body: JSON.stringify({ messages: [], model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "llm_api_unavailable" } });
	});

	it("aborts an LLM API that misses the first-byte deadline", async () => {
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, release },
			llmApiFetch: async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
			providerRequestLimits: { firstByteTimeoutMs: 10, totalTimeoutMs: 100 },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(504);
		expect(await response.json()).toMatchObject({ error: { code: "llm_api_timeout" } });
		expect(release).toHaveBeenCalledOnce();
	});

	it("aborts an idle provider stream and releases its admission lease", async () => {
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, release },
			llmApiFetch: async (_input, init) => {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
					},
				});
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
			providerRequestLimits: { streamIdleTimeoutMs: 10, totalTimeoutMs: 100 },
		});
		const response = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [], model: "fast", stream: true }),
				headers: authHeaders(),
				method: "POST",
			},
			env(),
		);
		await expect(response.text()).rejects.toThrow("aborted");
		expect(release).toHaveBeenCalledOnce();
	});

	it("keeps a provider stream active through a transient admission renewal failure", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-23T00:00:00Z"));
		try {
			let providerBody: ReadableStreamDefaultController<Uint8Array> | undefined;
			let providerAborted = false;
			const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
			const renew = vi
				.fn<AdmissionClient["renew"]>()
				.mockResolvedValueOnce({ ok: false, reason: "unavailable" })
				.mockImplementation(async () => ({ leaseExpiresAt: Date.now() + LEASE_TTL_MS, ok: true }));
			const app = createApp({
				admissionClient: {
					async acquire(_env, _accountId, _keyId, leaseId) {
						return {
							leaseExpiresAt: Date.now() + LEASE_TTL_MS,
							leaseId,
							ok: true,
							rateLimit: RATE_LIMIT,
						};
					},
					release,
					renew,
				},
				llmApiFetch: async (_input, init) =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								providerBody = controller;
								init?.signal?.addEventListener(
									"abort",
									() => {
										providerAborted = true;
										controller.error(new Error("aborted"));
									},
									{ once: true },
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			});
			const response = await app.request(
				"/v1/chat/completions",
				{
					body: JSON.stringify({ messages: [], model: "fast", stream: true }),
					headers: authHeaders(),
					method: "POST",
				},
				env(),
			);

			await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
			expect(renew).toHaveBeenCalledOnce();
			expect(providerAborted).toBe(false);
			await vi.advanceTimersByTimeAsync(LEASE_RENEW_RETRY_INTERVAL_MS);
			expect(renew).toHaveBeenCalledTimes(2);
			expect(providerAborted).toBe(false);

			providerBody?.close();
			await response.text();
			expect(release).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("terminates provider bodies and SSE events that exceed response limits", async () => {
		for (const scenario of ["body", "event"] as const) {
			const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
			const app = createApp({
				admissionClient: { ...allowingAdmissionClient, release },
				llmApiFetch: async () =>
					new Response(
						scenario === "event" ? `data: ${"x".repeat(100)}\n\n` : JSON.stringify({ data: "x".repeat(100) }),
						{
							headers: { "content-type": scenario === "event" ? "text/event-stream" : "application/json" },
						},
					),
				providerRequestLimits: {
					maxResponseBytes: scenario === "body" ? 32 : 1_024,
					maxSseEventBytes: 32,
				},
			});
			const response = await app.request(
				scenario === "event" ? "/v1/chat/completions" : "/v1/responses",
				{
					body: JSON.stringify(
						scenario === "event" ? { messages: [], model: "fast", stream: true } : { input: "hello", model: "fast" },
					),
					headers: authHeaders(),
					method: "POST",
				},
				env(),
			);
			await expect(response.text()).rejects.toThrow(
				scenario === "event" ? "stream_event_too_large" : "response_too_large",
			);
			expect(release).toHaveBeenCalledOnce();
		}
	});

	it("rejects incompatible successful provider content types", async () => {
		const app = testApp({ llmApiFetch: async () => new Response("unexpected", { status: 200 }) });
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_llm_api_response" } });
	});

	it("logs a redacted operational event after admission release retries fail", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const app = createApp({
				admissionClient: {
					...allowingAdmissionClient,
					async release() {
						return false;
					},
				},
				llmApiFetch: async () => Response.json({ id: "resp_test", object: "response" }),
			});
			const response = await app.request(
				"/v1/responses",
				{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
				env(),
			);
			await response.text();
			expect(warning).toHaveBeenCalledWith(expect.stringContaining('"event":"admission_release_failed"'));
			expect(warning.mock.calls[0]?.[0]).not.toContain("test-key");
		} finally {
			warning.mockRestore();
		}
	});

	it("fails closed when the admission Durable Object binding is missing", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const app = createApp({ llmApiFetch: llmApi });
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("rejects an inference request when admission limits are reached", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const app = createApp({
			admissionClient: {
				async acquire() {
					return {
						ok: false,
						rateLimit: { ...RATE_LIMIT, remainingRequests: 0 },
						reason: "rate_limit",
						retryAfterSeconds: 37,
					};
				},
				async release() {
					return true;
				},
				async renew() {
					return { leaseExpiresAt: Date.now() + LEASE_TTL_MS, ok: true };
				},
			},
			llmApiFetch: llmApi,
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("37");
		expect(await response.json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("rejects oversized request bodies before forwarding", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		const app = createApp({
			admissionClient: {
				async acquire(_env, _accountId, _keyId, leaseId) {
					return { leaseExpiresAt: TEST_LEASE_EXPIRES_AT, leaseId, ok: true, rateLimit: RATE_LIMIT };
				},
				release,
				async renew() {
					return { leaseExpiresAt: Date.now() + LEASE_TTL_MS, ok: true };
				},
			},
			llmApiFetch: llmApi,
		});
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "x".repeat(MAX_REQUEST_BODY_BYTES), model: "fast" }),
				headers: authHeaders(),
				method: "POST",
			},
			env(),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
		expect(release).toHaveBeenCalledOnce();
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("uses each bootstrap key digest as its synthetic account and key identity", async () => {
		const accountIds: string[] = [];
		const keyIds: string[] = [];
		const app = createApp({
			admissionClient: {
				async acquire(_env, accountId, keyId, leaseId) {
					accountIds.push(accountId);
					keyIds.push(keyId);
					return { leaseExpiresAt: TEST_LEASE_EXPIRES_AT, leaseId, ok: true, rateLimit: RATE_LIMIT };
				},
				async release() {
					return true;
				},
				async renew() {
					return { leaseExpiresAt: Date.now() + LEASE_TTL_MS, ok: true };
				},
			},
			llmApiFetch: async () => Response.json({ id: "resp_test", model: MODEL_ID, object: "response" }),
		});
		for (const key of ["test-key", "second-key"]) {
			const response = await app.request(
				"/v1/responses",
				{
					body: JSON.stringify({ input: "hello", model: "fast" }),
					headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
					method: "POST",
				},
				env(),
			);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(keyIds).toHaveLength(2);
		expect(keyIds[0]).toMatch(/^[a-f0-9]{64}$/);
		expect(keyIds[0]).not.toBe(keyIds[1]);
		expect(accountIds).toEqual(keyIds);
		expect(keyIds).not.toContain("test-key");
		expect(keyIds).not.toContain("second-key");
	});
});
