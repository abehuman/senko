import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { CloudflareBindings, LlmApiFetch } from "../src/types";

const MODEL_ID = "provider/coding-model";

function env(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
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
		const app = createApp();
		await expect((await app.request("/health")).json()).resolves.toEqual({ status: "ok" });
		await expect((await app.request("/")).json()).resolves.toEqual({ name: "Senko API", status: "ok" });
	});

	it("requires a configured API key secret", async () => {
		const app = createApp();
		const response = await app.request("/v1/models", {}, env({ SENKO_API_KEYS: undefined }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
	});

	it("returns the same authentication error for missing and invalid keys", async () => {
		const app = createApp();
		const missing = await app.request("/v1/models", {}, env());
		const invalid = await app.request("/v1/models", { headers: { authorization: "Bearer wrong" } }, env());
		expect(missing.status).toBe(401);
		expect(invalid.status).toBe(401);
		expect(await missing.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(await invalid.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(missing.headers.get("x-request-id")).toMatch(/^req_[a-f0-9]{32}$/);
	});

	it("lists the fast alias and curated model metadata", async () => {
		const app = createApp();
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
		const app = createApp();
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
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer llm-secret");
			return new Response(`data: {"model":"${MODEL_ID}"}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream", "x-ratelimit-remaining-requests": "9" },
			});
		});
		const app = createApp({ llmApiFetch: llmApi });
		const response = await app.request(
			"/v1/chat/completions",
			{ body: JSON.stringify({ messages: [], model: "fast", stream: true }), headers: authHeaders(), method: "POST" },
			env(),
		);
		expect(llmApi).toHaveBeenCalledWith("https://llm.example/v1/chat/completions", expect.any(Object));
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("9");
		expect(await response.text()).toContain("data: [DONE]");
	});

	it("forwards Responses requests to the Responses endpoint", async () => {
		const llmApi = vi.fn<LlmApiFetch>(async (_input) =>
			Response.json({ id: "resp_test", model: MODEL_ID, object: "response" }),
		);
		const app = createApp({ llmApiFetch: llmApi });
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
		const app = createApp({ llmApiFetch: llmApi });
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

	it("normalizes non-compatible LLM API errors", async () => {
		const app = createApp({
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

	it("does not expose LLM API authentication errors", async () => {
		const app = createApp({
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
		const app = createApp({
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
});
