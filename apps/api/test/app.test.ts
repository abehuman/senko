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
import type { OperationalLogger } from "../src/observability";
import type { ProviderPoolClient } from "../src/provider-pool";
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

const silentOperationalLogger: OperationalLogger = { emit() {} };

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

const allowingProviderPoolClient: ProviderPoolClient = {
	async acquire(_env, _routeId, _capacity, leaseId) {
		return {
			circuitOpenUntil: 0,
			leaseExpiresAt: TEST_LEASE_EXPIRES_AT,
			leaseId,
			ok: true,
			remainingConcurrentRequests: 9,
			remainingRequests: 119,
			remainingTokens: 199_000,
			resetSeconds: 60,
		};
	},
	async release() {
		return { circuitOpenUntil: 0, consecutiveFailures: 0, released: true };
	},
	async renew() {
		return { leaseExpiresAt: TEST_LEASE_EXPIRES_AT, ok: true };
	},
};

function testApp(options: NonNullable<Parameters<typeof createApp>[0]> = {}) {
	return createApp({
		admissionClient: allowingAdmissionClient,
		operationalLogger: silentOperationalLogger,
		providerPoolClient: allowingProviderPoolClient,
		...options,
	});
}

function env(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
		SENKO_AUTH_MODE: "bootstrap",
		SENKO_API_KEYS: "test-key,second-key",
		SENKO_FAST_MODEL: MODEL_ID,
		SENKO_INFERENCE_ENABLED: "true",
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

function completedResponse(id = "resp_test"): Record<string, unknown> {
	return {
		created_at: 1,
		id,
		model: MODEL_ID,
		object: "response",
		output: [],
		status: "completed",
		usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
	};
}

function completedChatStream(): string {
	return [
		`data: ${JSON.stringify({
			choices: [{ delta: { content: "ok", role: "assistant" }, finish_reason: "stop", index: 0 }],
			created: 1,
			id: "chatcmpl_test",
			model: MODEL_ID,
			object: "chat.completion.chunk",
		})}\n\n`,
		`data: ${JSON.stringify({
			choices: [],
			created: 1,
			id: "chatcmpl_test",
			model: MODEL_ID,
			object: "chat.completion.chunk",
			usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
		})}\n\n`,
		"data: [DONE]\n\n",
	].join("");
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

	it("stops all inference before admission when the emergency kill switch is active", async () => {
		const acquire = vi.fn<AdmissionClient["acquire"]>();
		const llmApi = vi.fn<LlmApiFetch>();
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, acquire },
			llmApiFetch: llmApi,
			operationalLogger: { emit },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({ SENKO_INFERENCE_ENABLED: "false" }),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "inference_disabled" } });
		expect(acquire).not.toHaveBeenCalled();
		expect(llmApi).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "inference_kill_switch", outcome: "denied" }));
	});

	it("fails closed before admission when the emergency kill switch is missing", async () => {
		const acquire = vi.fn<AdmissionClient["acquire"]>();
		const llmApi = vi.fn<LlmApiFetch>();
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, acquire },
			llmApiFetch: llmApi,
			operationalLogger: silentOperationalLogger,
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({ SENKO_INFERENCE_ENABLED: undefined }),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "configuration_error", message: expect.stringContaining("SENKO_INFERENCE_ENABLED") },
		});
		expect(acquire).not.toHaveBeenCalled();
		expect(llmApi).not.toHaveBeenCalled();
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
			return new Response(completedChatStream(), {
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
			return Response.json(completedResponse());
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

	it("forwards client-defined parallel tool calls and tool results for both protocols", async () => {
		const forwarded: Record<string, unknown>[] = [];
		const llmApi = vi.fn<LlmApiFetch>(async (input, init) => {
			forwarded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return String(input).endsWith("/chat/completions")
				? Response.json({
						choices: [
							{
								finish_reason: "stop",
								index: 0,
								message: { content: "done", role: "assistant" },
							},
						],
						created: 1,
						id: "chatcmpl_tools",
						model: MODEL_ID,
						object: "chat.completion",
						usage: { completion_tokens: 1, prompt_tokens: 10, total_tokens: 11 },
					})
				: Response.json(completedResponse("resp_tools"));
		});
		const app = testApp({ llmApiFetch: llmApi });
		const tools = [
			{
				function: {
					description: "Read one source file",
					name: "read_file",
					parameters: {
						additionalProperties: false,
						properties: { path: { type: "string" } },
						required: ["path"],
						type: "object",
					},
				},
				type: "function",
			},
		];
		const chatMessages = [
			{ content: "read both files", role: "user" },
			{
				content: null,
				role: "assistant",
				tool_calls: [
					{ function: { arguments: '{"path":"a.ts"}', name: "read_file" }, id: "call_a", type: "function" },
					{ function: { arguments: '{"path":"b.ts"}', name: "read_file" }, id: "call_b", type: "function" },
				],
			},
			{ content: "content a", role: "tool", tool_call_id: "call_a" },
			{ content: "content b", role: "tool", tool_call_id: "call_b" },
		];
		const chatResponse = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: chatMessages, model: "fast", parallel_tool_calls: true, tools }),
				headers: authHeaders(),
				method: "POST",
			},
			env(),
		);
		expect(chatResponse.status).toBe(200);

		const responsesInput = [
			{ content: [{ text: "read both files", type: "input_text" }], role: "user", type: "message" },
			{
				arguments: '{"path":"a.ts"}',
				call_id: "call_a",
				name: "read_file",
				type: "function_call",
			},
			{ call_id: "call_a", output: "content a", type: "function_call_output" },
		];
		const responsesResponse = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: responsesInput, model: "fast", parallel_tool_calls: true, tools }),
				headers: authHeaders(),
				method: "POST",
			},
			env(),
		);
		expect(responsesResponse.status).toBe(200);

		expect(forwarded[0]).toMatchObject({ messages: chatMessages, parallel_tool_calls: true, tools });
		expect(forwarded[1]).toMatchObject({ input: responsesInput, parallel_tool_calls: true, tools });
	});

	it("uses the highest-priority matching provider route without exposing its model ID", async () => {
		const llmApi = vi.fn<LlmApiFetch>(async (_input, init) => {
			expect(JSON.parse(String(init?.body)).model).toBe("upstream/coding-model");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer route-secret");
			return Response.json(completedResponse());
		});
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = testApp({ llmApiFetch: llmApi, operationalLogger: { emit } });
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENAI: "route-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 10, requests_per_minute: 120, tokens_per_minute: 200_000 },
						destination: "openai",
						id: "singapore-primary",
						models: { [MODEL_ID]: "upstream/coding-model" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);
		expect(response.status).toBe(200);
		expect(llmApi.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
		expect(await response.json()).toMatchObject({ model: MODEL_ID });
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_route_selected",
				provider_route: "singapore-primary",
				schema_version: 1,
			}),
		);
	});

	it("selects the next route before provider forwarding when the preferred pool has no capacity", async () => {
		const acquire = vi.fn<ProviderPoolClient["acquire"]>(async (_env, routeId, _capacity, leaseId) => {
			if (routeId === "primary") {
				return {
					circuitOpenUntil: Date.now() + 30_000,
					ok: false,
					reason: "circuit_open",
					remainingConcurrentRequests: 0,
					remainingRequests: 0,
					remainingTokens: 0,
					retryAfterSeconds: 30,
					resetSeconds: 30,
				};
			}
			return {
				circuitOpenUntil: 0,
				leaseExpiresAt: TEST_LEASE_EXPIRES_AT,
				leaseId,
				ok: true,
				remainingConcurrentRequests: 4,
				remainingRequests: 59,
				remainingTokens: 99_000,
				resetSeconds: 60,
			};
		});
		const release = vi.fn<ProviderPoolClient["release"]>(async () => ({
			circuitOpenUntil: 0,
			consecutiveFailures: 0,
			released: true,
		}));
		const providerPoolClient: ProviderPoolClient = {
			acquire,
			release,
			async renew() {
				return { leaseExpiresAt: TEST_LEASE_EXPIRES_AT, ok: true };
			},
		};
		const llmApi = vi.fn<LlmApiFetch>(async () => Response.json(completedResponse()));
		const app = testApp({ llmApiFetch: llmApi, providerPoolClient });
		const routeCapacity = { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 };
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_KEY_OPENROUTER: "openrouter-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: routeCapacity,
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: "primary/model" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
					{
						capacity: routeCapacity,
						destination: "openrouter",
						id: "secondary",
						models: { [MODEL_ID]: "secondary/model" },
						priority: 10,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);

		expect(response.status).toBe(200);
		expect(acquire.mock.calls.map((call) => call[1])).toEqual(["primary", "secondary"]);
		expect(llmApi).toHaveBeenCalledOnce();
		expect(llmApi.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/responses");
		expect(JSON.parse(String(llmApi.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "secondary/model" });
		expect(release).toHaveBeenCalledWith(expect.anything(), "secondary", expect.stringMatching(/^req_/), "succeeded");
	});

	it("does not retry another route after provider response bytes have started", async () => {
		const acquire = vi.fn<ProviderPoolClient["acquire"]>(allowingProviderPoolClient.acquire);
		const release = vi.fn<ProviderPoolClient["release"]>(allowingProviderPoolClient.release);
		const llmApi = vi.fn<LlmApiFetch>(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_test","output_index":0,"content_index":0,"delta":"partial"}\n\n',
						),
					);
					controller.error(new Error("provider transport failed"));
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		});
		const app = testApp({
			llmApiFetch: llmApi,
			providerPoolClient: { ...allowingProviderPoolClient, acquire, release },
		});
		const routeCapacity = { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 };
		const response = await app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: "fast", stream: true }),
				headers: authHeaders(),
				method: "POST",
			},
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_KEY_OPENROUTER: "openrouter-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: routeCapacity,
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: "primary/model" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
					{
						capacity: routeCapacity,
						destination: "openrouter",
						id: "secondary",
						models: { [MODEL_ID]: "secondary/model" },
						priority: 10,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow("provider transport failed");
		expect(acquire.mock.calls.map((call) => call[1])).toEqual(["primary"]);
		expect(llmApi).toHaveBeenCalledOnce();
		expect(llmApi.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
		expect(release).toHaveBeenCalledWith(expect.anything(), "primary", expect.stringMatching(/^req_/), "route_failure");
	});

	it("fails closed before provider forwarding when explicit routes lack the provider pool binding", async () => {
		const llmApi = vi.fn<LlmApiFetch>();
		const app = createApp({
			admissionClient: allowingAdmissionClient,
			llmApiFetch: llmApi,
			operationalLogger: silentOperationalLogger,
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: "primary/model" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
		expect(llmApi).not.toHaveBeenCalled();
	});

	it("marks a valid bootstrap stream as provider-pool success", async () => {
		const release = vi.fn<ProviderPoolClient["release"]>(allowingProviderPoolClient.release);
		const providerPoolClient = { ...allowingProviderPoolClient, release };
		const app = testApp({
			llmApiFetch: async () =>
				new Response(completedChatStream(), { headers: { "content-type": "text/event-stream" } }),
			providerPoolClient,
		});
		const response = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: "fast", stream: true }),
				headers: authHeaders(),
				method: "POST",
			},
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-completions"],
					},
				]),
			}),
		);
		expect(response.status).toBe(200);
		await response.text();
		expect(release).toHaveBeenCalledWith(expect.anything(), "primary", expect.stringMatching(/^req_/), "succeeded");
	});

	it("keeps valid incomplete Responses terminals neutral for shared route health", async () => {
		const release = vi.fn<ProviderPoolClient["release"]>(allowingProviderPoolClient.release);
		const providerPoolClient = { ...allowingProviderPoolClient, release };
		const incomplete = {
			...completedResponse(),
			incomplete_details: { reason: "max_output_tokens" },
			status: "incomplete",
		};
		const app = testApp({
			llmApiFetch: async () =>
				new Response(
					`event: response.incomplete\ndata: ${JSON.stringify({ response: incomplete, sequence_number: 1, type: "response.incomplete" })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
			providerPoolClient,
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast", stream: true }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);
		expect(response.status).toBe(200);
		await response.text();
		expect(release).toHaveBeenCalledWith(expect.anything(), "primary", expect.stringMatching(/^req_/), "neutral");
	});

	it("keeps valid non-stream incomplete Responses neutral for shared route health", async () => {
		const release = vi.fn<ProviderPoolClient["release"]>(allowingProviderPoolClient.release);
		const incomplete = {
			...completedResponse(),
			incomplete_details: { reason: "max_output_tokens" },
			status: "incomplete",
		};
		const app = testApp({
			llmApiFetch: async () => Response.json(incomplete),
			providerPoolClient: { ...allowingProviderPoolClient, release },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "incomplete" });
		expect(release).toHaveBeenCalledWith(expect.anything(), "primary", expect.stringMatching(/^req_/), "neutral");
	});

	it("opens the failed-credential route circuit and sends a later request to the secondary route", async () => {
		let primaryFailures = 0;
		const releaseOutcomes: Array<{ outcome: string; routeId: string }> = [];
		const providerPoolClient: ProviderPoolClient = {
			async acquire(_env, routeId, _capacity, leaseId) {
				if (routeId === "primary" && primaryFailures >= 5) {
					return {
						circuitOpenUntil: Date.now() + 30_000,
						ok: false,
						reason: "circuit_open",
						remainingConcurrentRequests: 5,
						remainingRequests: 55,
						remainingTokens: 90_000,
						retryAfterSeconds: 30,
						resetSeconds: 30,
					};
				}
				return {
					...(await allowingProviderPoolClient.acquire(_env, routeId, _capacity, leaseId, 1, Date.now() + 60_000)),
				};
			},
			async release(_env, routeId, _leaseId, outcome) {
				releaseOutcomes.push({ outcome, routeId });
				if (routeId === "primary" && outcome === "route_failure") primaryFailures += 1;
				return {
					circuitOpenUntil: primaryFailures >= 5 ? Date.now() + 30_000 : 0,
					consecutiveFailures: primaryFailures % 5,
					released: true,
				};
			},
			renew: allowingProviderPoolClient.renew,
		};
		const calledUrls: string[] = [];
		const app = testApp({
			llmApiFetch: async (input) => {
				calledUrls.push(String(input));
				return String(input).startsWith("https://api.openai.com")
					? Response.json(
							{ error: { code: "invalid_api_key", message: "invalid key", type: "authentication_error" } },
							{ status: 401 },
						)
					: Response.json(completedResponse());
			},
			providerPoolClient,
		});
		const routeCapacity = { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 };
		const routeEnv = env({
			SENKO_PROVIDER_KEY_OPENAI: "expired-openai-secret",
			SENKO_PROVIDER_KEY_OPENROUTER: "working-openrouter-secret",
			SENKO_PROVIDER_ROUTES: JSON.stringify([
				{
					capacity: routeCapacity,
					destination: "openai",
					id: "primary",
					models: { [MODEL_ID]: MODEL_ID },
					priority: 0,
					supported_protocols: ["openai-responses"],
				},
				{
					capacity: routeCapacity,
					destination: "openrouter",
					id: "secondary",
					models: { [MODEL_ID]: MODEL_ID },
					priority: 10,
					supported_protocols: ["openai-responses"],
				},
			]),
		});
		for (let index = 0; index < 5; index += 1) {
			const response = await app.request(
				"/v1/responses",
				{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
				routeEnv,
			);
			expect(response.status).toBe(502);
		}
		const recovered = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			routeEnv,
		);
		expect(recovered.status).toBe(200);
		expect(calledUrls.slice(0, 5).every((url) => url === "https://api.openai.com/v1/responses")).toBe(true);
		expect(calledUrls.at(-1)).toBe("https://openrouter.ai/api/v1/responses");
		expect(releaseOutcomes.filter((entry) => entry.routeId === "primary").map((entry) => entry.outcome)).toEqual([
			"route_failure",
			"route_failure",
			"route_failure",
			"route_failure",
			"route_failure",
		]);
	});

	it("counts provider credit exhaustion as a route failure", async () => {
		const release = vi.fn<ProviderPoolClient["release"]>(allowingProviderPoolClient.release);
		const app = testApp({
			llmApiFetch: async () =>
				Response.json(
					{ error: { code: "insufficient_credits", message: "credits exhausted", type: "payment_required" } },
					{ status: 402 },
				),
			providerPoolClient: { ...allowingProviderPoolClient, release },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENROUTER: "openrouter-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openrouter",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);
		expect(response.status).toBe(502);
		expect(release).toHaveBeenCalledWith(expect.anything(), "primary", expect.stringMatching(/^req_/), "route_failure");
	});

	it("opens the server-error stream route circuit and sends a later request to the secondary route", async () => {
		let primaryFailures = 0;
		const releaseOutcomes: Array<{ outcome: string; routeId: string }> = [];
		const providerPoolClient: ProviderPoolClient = {
			async acquire(_env, routeId, _capacity, leaseId) {
				if (routeId === "primary" && primaryFailures >= 5) {
					return {
						circuitOpenUntil: Date.now() + 30_000,
						ok: false,
						reason: "circuit_open",
						remainingConcurrentRequests: 5,
						remainingRequests: 55,
						remainingTokens: 90_000,
						retryAfterSeconds: 30,
						resetSeconds: 30,
					};
				}
				return allowingProviderPoolClient.acquire(_env, routeId, _capacity, leaseId, 1, Date.now() + 60_000);
			},
			async release(_env, routeId, _leaseId, outcome) {
				releaseOutcomes.push({ outcome, routeId });
				if (routeId === "primary" && outcome === "route_failure") primaryFailures += 1;
				return {
					circuitOpenUntil: primaryFailures >= 5 ? Date.now() + 30_000 : 0,
					consecutiveFailures: primaryFailures % 5,
					released: true,
				};
			},
			renew: allowingProviderPoolClient.renew,
		};
		const calledUrls: string[] = [];
		const app = testApp({
			llmApiFetch: async (input) => {
				const url = String(input);
				calledUrls.push(url);
				const response = url.startsWith("https://api.openai.com")
					? {
							...completedResponse(),
							error: { code: "server_error", message: "temporary provider failure" },
							status: "failed",
						}
					: completedResponse();
				const type = response.status === "failed" ? "response.failed" : "response.completed";
				return new Response(`event: ${type}\ndata: ${JSON.stringify({ response, sequence_number: 1, type })}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
			providerPoolClient,
		});
		const routeCapacity = { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 };
		const routeEnv = env({
			SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
			SENKO_PROVIDER_KEY_OPENROUTER: "openrouter-secret",
			SENKO_PROVIDER_ROUTES: JSON.stringify([
				{
					capacity: routeCapacity,
					destination: "openai",
					id: "primary",
					models: { [MODEL_ID]: MODEL_ID },
					priority: 0,
					supported_protocols: ["openai-responses"],
				},
				{
					capacity: routeCapacity,
					destination: "openrouter",
					id: "secondary",
					models: { [MODEL_ID]: MODEL_ID },
					priority: 10,
					supported_protocols: ["openai-responses"],
				},
			]),
		});
		for (let index = 0; index < 6; index += 1) {
			const response = await app.request(
				"/v1/responses",
				{
					body: JSON.stringify({ input: "hello", model: "fast", stream: true }),
					headers: authHeaders(),
					method: "POST",
				},
				routeEnv,
			);
			expect(response.status).toBe(200);
			await response.text();
		}
		expect(calledUrls.slice(0, 5).every((url) => url === "https://api.openai.com/v1/responses")).toBe(true);
		expect(calledUrls.at(-1)).toBe("https://openrouter.ai/api/v1/responses");
		expect(releaseOutcomes.filter((entry) => entry.routeId === "primary").map((entry) => entry.outcome)).toEqual([
			"route_failure",
			"route_failure",
			"route_failure",
			"route_failure",
			"route_failure",
		]);
	});

	it("emits versioned lifecycle timings without customer or provider content", async () => {
		const privatePrompt = "private-prompt-value";
		const privateGeneratedText = "private-generated-value";
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = testApp({
			llmApiFetch: async () =>
				Response.json({
					...completedResponse(),
					output: [
						{
							content: [{ text: privateGeneratedText, type: "output_text" }],
							id: "msg_test",
							role: "assistant",
							status: "completed",
							type: "message",
						},
					],
				}),
			operationalLogger: { emit },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: privatePrompt, model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(response.status).toBe(200);
		await response.text();
		const events = emit.mock.calls.map(([event]) => event);
		expect(events.map((event) => event.event)).toEqual(
			expect.arrayContaining([
				"request_started",
				"authentication_completed",
				"admission_completed",
				"provider_route_selected",
				"provider_response_headers",
				"provider_first_byte",
				"provider_completed",
				"request_finished",
			]),
		);
		expect(events.every((event) => event.schema_version === 1)).toBe(true);
		expect(events.find((event) => event.event === "provider_completed")).toMatchObject({
			duration_ms: expect.any(Number),
			outcome: "succeeded",
			terminal_reason: "completed",
		});
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(privatePrompt);
		expect(serialized).not.toContain(privateGeneratedText);
		expect(serialized).not.toContain("llm-secret");
		expect(serialized).not.toContain("test-key");
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

	it("rejects successful provider responses without a body for JSON and SSE", async () => {
		const release = vi.fn<ProviderPoolClient["release"]>().mockResolvedValue({
			circuitOpenUntil: 0,
			consecutiveFailures: 1,
			released: true,
		});
		const app = testApp({
			llmApiFetch: async (_input, init) =>
				new Response(null, {
					headers: {
						"content-type": JSON.parse(String(init?.body)).stream === true ? "text/event-stream" : "application/json",
					},
					status: 200,
				}),
			providerPoolClient: { ...allowingProviderPoolClient, release },
		});
		const requests = [
			{ body: { input: "hello", model: "fast" }, path: "/v1/responses" },
			{ body: { messages: [], model: "fast", stream: true }, path: "/v1/chat/completions" },
		];

		for (const request of requests) {
			const response = await app.request(
				request.path,
				{ body: JSON.stringify(request.body), headers: authHeaders(), method: "POST" },
				env({
					SENKO_PROVIDER_KEY_OPENAI: "route-secret",
					SENKO_PROVIDER_ROUTES: JSON.stringify([
						{
							capacity: {
								max_concurrent_requests: 10,
								requests_per_minute: 120,
								tokens_per_minute: 200_000,
							},
							destination: "openai",
							id: "primary",
							models: { [MODEL_ID]: "upstream/coding-model" },
							priority: 0,
							supported_protocols: ["openai-completions", "openai-responses"],
						},
					]),
				}),
			);

			expect(response.status).toBe(502);
			expect(await response.json()).toMatchObject({
				error: { code: "invalid_llm_api_response", type: "llm_api_error" },
			});
		}
		expect(release).toHaveBeenCalledTimes(2);
		expect(release).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			"primary",
			expect.stringMatching(/^req_/),
			"route_failure",
		);
		expect(release).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			"primary",
			expect.stringMatching(/^req_/),
			"route_failure",
		);
	});

	it("refuses provider redirects before credentials or request bodies can reach another origin", async () => {
		const release = vi.fn<ProviderPoolClient["release"]>().mockResolvedValue({
			circuitOpenUntil: 0,
			consecutiveFailures: 1,
			released: true,
		});
		const llmApi = vi.fn<LlmApiFetch>(async (_input, init) => {
			expect(init?.redirect).toBe("error");
			throw new TypeError("provider redirect rejected");
		});
		const app = testApp({
			llmApiFetch: llmApi,
			providerPoolClient: { ...allowingProviderPoolClient, release },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env({
				SENKO_PROVIDER_KEY_OPENAI: "route-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 10, requests_per_minute: 120, tokens_per_minute: 200_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: "upstream/coding-model" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { code: "llm_api_unavailable" } });
		expect(llmApi).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith(expect.anything(), "primary", expect.stringMatching(/^req_/), "route_failure");
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

	it("cancels provider forwarding before response headers when the client disconnects", async () => {
		const client = new AbortController();
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		let markProviderStarted: (() => void) | undefined;
		const providerStarted = new Promise<void>((resolve) => {
			markProviderStarted = resolve;
		});
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, release },
			llmApiFetch: async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					markProviderStarted?.();
					const signal = init?.signal;
					const abort = () => reject(new Error("provider request cancelled"));
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				}),
		});
		const responsePromise = app.request(
			"/v1/responses",
			{
				body: JSON.stringify({ input: "hello", model: "fast" }),
				headers: authHeaders(),
				method: "POST",
				signal: client.signal,
			},
			env(),
		);
		await providerStarted;
		client.abort();

		const response = await responsePromise;
		expect(response.status).toBe(499);
		expect(await response.json()).toMatchObject({ error: { code: "request_cancelled" } });
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

	it("keeps a provider stream alive while chunks arrive inside the idle deadline", async () => {
		const stream = new TextEncoder().encode(completedChatStream());
		const splitAt = Math.floor(stream.byteLength / 2);
		const app = testApp({
			llmApiFetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(stream.slice(0, splitAt));
							setTimeout(() => {
								controller.enqueue(stream.slice(splitAt));
								controller.close();
							}, 10);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			providerRequestLimits: { streamIdleTimeoutMs: 50, totalTimeoutMs: 200 },
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

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("data: [DONE]");
	});

	it("rejects an abruptly terminated successful provider stream and releases admission", async () => {
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, release },
			llmApiFetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"upstream","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
								),
							);
							controller.error(new Error("provider connection reset"));
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

		await expect(response.text()).rejects.toThrow("provider connection reset");
		expect(release).toHaveBeenCalledOnce();
	});

	it("cancels the provider body and releases admission between headers and the first stream event", async () => {
		let providerCancelled = false;
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		const providerRelease = vi
			.fn<ProviderPoolClient["release"]>()
			.mockResolvedValue({ circuitOpenUntil: 0, consecutiveFailures: 0, released: true });
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, release },
			llmApiFetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							providerCancelled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			providerPoolClient: { ...allowingProviderPoolClient, release: providerRelease },
		});
		const response = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [], model: "fast", stream: true }),
				headers: authHeaders(),
				method: "POST",
			},
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-completions"],
					},
				]),
			}),
		);
		await response.body?.cancel("client stopped before the first event");

		expect(providerCancelled).toBe(true);
		expect(release).toHaveBeenCalledOnce();
		expect(providerRelease).toHaveBeenCalledWith(expect.anything(), "primary", expect.any(String), "neutral");
	});

	it("cancels the provider body and releases admission when the client stops an active stream", async () => {
		let providerCancelled = false;
		const release = vi.fn<AdmissionClient["release"]>().mockResolvedValue(true);
		const providerRelease = vi
			.fn<ProviderPoolClient["release"]>()
			.mockResolvedValue({ circuitOpenUntil: 0, consecutiveFailures: 0, released: true });
		const app = createApp({
			admissionClient: { ...allowingAdmissionClient, release },
			llmApiFetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							providerCancelled = true;
						},
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({
										choices: [{ delta: { content: "partial", role: "assistant" }, finish_reason: null, index: 0 }],
										created: 1,
										id: "chatcmpl_partial",
										model: MODEL_ID,
										object: "chat.completion.chunk",
									})}\n\n`,
								),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			providerPoolClient: { ...allowingProviderPoolClient, release: providerRelease },
		});
		const response = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [], model: "fast", stream: true }),
				headers: authHeaders(),
				method: "POST",
			},
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-completions"],
					},
				]),
			}),
		);
		const reader = response.body?.getReader();
		expect(await reader?.read()).toMatchObject({ done: false });
		await reader?.cancel("client stopped reading");

		expect(providerCancelled).toBe(true);
		expect(release).toHaveBeenCalledOnce();
		expect(providerRelease).toHaveBeenCalledWith(expect.anything(), "primary", expect.any(String), "neutral");
	});

	it("keeps a completed Chat stream successful when the client cancels before provider EOF", async () => {
		const providerRelease = vi
			.fn<ProviderPoolClient["release"]>()
			.mockResolvedValue({ circuitOpenUntil: 0, consecutiveFailures: 0, released: true });
		const app = createApp({
			admissionClient: allowingAdmissionClient,
			llmApiFetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(completedChatStream()));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			providerPoolClient: { ...allowingProviderPoolClient, release: providerRelease },
		});
		const response = await app.request(
			"/v1/chat/completions",
			{
				body: JSON.stringify({ messages: [], model: "fast", stream: true }),
				headers: authHeaders(),
				method: "POST",
			},
			env({
				SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
						destination: "openai",
						id: "primary",
						models: { [MODEL_ID]: MODEL_ID },
						priority: 0,
						supported_protocols: ["openai-completions"],
					},
				]),
			}),
		);
		const reader = response.body?.getReader();
		let received = "";
		while (!received.includes("[DONE]")) {
			const event = await reader?.read();
			expect(event?.done).toBe(false);
			received += new TextDecoder().decode(event?.value);
		}
		await reader?.cancel("terminal received");

		expect(providerRelease).toHaveBeenCalledWith(expect.anything(), "primary", expect.any(String), "succeeded");
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

			providerBody?.enqueue(new TextEncoder().encode(completedChatStream()));
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
			if (scenario === "event") {
				await expect(response.text()).rejects.toThrow("stream_event_too_large");
			} else {
				expect(response.status).toBe(502);
				expect(await response.json()).toMatchObject({ error: { code: "llm_api_unavailable" } });
			}
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
		const emit = vi.fn<OperationalLogger["emit"]>();
		const app = createApp({
			admissionClient: {
				...allowingAdmissionClient,
				async release() {
					return false;
				},
			},
			llmApiFetch: async () => Response.json(completedResponse()),
			operationalLogger: { emit },
		});
		const response = await app.request(
			"/v1/responses",
			{ body: JSON.stringify({ input: "hello", model: "fast" }), headers: authHeaders(), method: "POST" },
			env(),
		);
		await response.text();
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "admission_lease_release",
				failure_category: "admission",
				outcome: "failed",
				schema_version: 1,
			}),
		);
		expect(JSON.stringify(emit.mock.calls)).not.toContain("test-key");
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
			llmApiFetch: async () => Response.json(completedResponse()),
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
