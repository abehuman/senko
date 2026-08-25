import { describe, expect, it } from "vitest";
import { getProviderRouteCandidates } from "../src/provider-routing";
import type { CloudflareBindings } from "../src/types";

const MODEL_ID = "senko/coding-model";

function configuredEnv(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
		SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
		SENKO_PROVIDER_KEY_OPENROUTER: "openrouter-secret",
		SENKO_PROVIDER_ROUTES: JSON.stringify([
			{
				capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
				destination: "openrouter",
				id: "secondary",
				models: { [MODEL_ID]: "secondary/coder" },
				priority: 20,
				supported_protocols: ["openai-completions", "openai-responses"],
			},
			{
				capacity: { max_concurrent_requests: 10, requests_per_minute: 120, tokens_per_minute: 200_000 },
				destination: "openai",
				id: "primary",
				models: { [MODEL_ID]: "primary/coder" },
				priority: 10,
				supported_protocols: ["openai-responses"],
			},
		]),
		...overrides,
	};
}

describe("provider route configuration", () => {
	it("selects matching routes deterministically and resolves provider model IDs", () => {
		const result = getProviderRouteCandidates(configuredEnv(), MODEL_ID, "openai-responses");
		expect(result).toEqual({
			ok: true,
			value: [
				{
					apiKey: "openai-secret",
					baseUrl: "https://api.openai.com/v1",
					capacity: { maxConcurrentRequests: 10, requestsPerMinute: 120, tokensPerMinute: 200_000 },
					id: "primary",
					priority: 10,
					providerModel: "primary/coder",
				},
				{
					apiKey: "openrouter-secret",
					baseUrl: "https://openrouter.ai/api/v1",
					capacity: { maxConcurrentRequests: 5, requestsPerMinute: 60, tokensPerMinute: 100_000 },
					id: "secondary",
					priority: 20,
					providerModel: "secondary/coder",
				},
			],
		});

		const chat = getProviderRouteCandidates(configuredEnv(), MODEL_ID, "openai-completions");
		expect(chat.ok && chat.value.map((route) => route.id)).toEqual(["secondary"]);
	});

	it("fails closed when a selected route secret is missing", () => {
		const result = getProviderRouteCandidates(
			configuredEnv({ SENKO_PROVIDER_KEY_OPENAI: undefined }),
			MODEL_ID,
			"openai-responses",
		);
		expect(result).toEqual({
			message: 'Set the SENKO_PROVIDER_KEY_OPENAI Worker secret required by provider route "primary".',
			ok: false,
		});
	});

	it("rejects unknown destinations, duplicate IDs, or unavailable route definitions", () => {
		const unknownDestination = getProviderRouteCandidates(
			configuredEnv({
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						capacity: { max_concurrent_requests: 1, requests_per_minute: 1, tokens_per_minute: 1 },
						destination: "attacker",
						id: "primary",
						models: { [MODEL_ID]: "primary/coder" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
			MODEL_ID,
			"openai-responses",
		);
		expect(unknownDestination.ok).toBe(false);
		expect(!unknownDestination.ok && unknownDestination.message).toContain("destination must be one of");

		const unavailable = getProviderRouteCandidates(configuredEnv(), "senko/other", "openai-responses");
		expect(unavailable.ok).toBe(false);
		expect(!unavailable.ok && unavailable.message).toContain("at least one provider route");
	});

	it("cannot send Senko or database credentials to a route-controlled origin", () => {
		const result = getProviderRouteCandidates(
			configuredEnv({
				SENKO_ADMIN_TOKEN: "admin-secret",
				SENKO_DATABASE_URL: "postgresql://database-secret@example.invalid/senko",
				SENKO_PROVIDER_ROUTES: JSON.stringify([
					{
						api_key_binding: "SENKO_ADMIN_TOKEN",
						base_url: "https://attacker.example/v1",
						capacity: { max_concurrent_requests: 1, requests_per_minute: 1, tokens_per_minute: 1 },
						destination: "openai",
						id: "malicious",
						models: { [MODEL_ID]: "stolen" },
						priority: 0,
						supported_protocols: ["openai-responses"],
					},
				]),
			}),
			MODEL_ID,
			"openai-responses",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toContain("unsupported fields: api_key_binding, base_url");
	});

	it("keeps the legacy single-route configuration as an explicit migration path", () => {
		const result = getProviderRouteCandidates(
			{ LLM_API_BASE_URL: "https://legacy.example/v1/", LLM_API_KEY: "legacy-secret" },
			MODEL_ID,
			"openai-responses",
		);
		expect(result).toEqual({
			ok: true,
			value: [
				{
					apiKey: "legacy-secret",
					baseUrl: "https://legacy.example/v1",
					capacity: undefined,
					id: "primary",
					priority: 0,
					providerModel: MODEL_ID,
				},
			],
		});
	});

	it("rejects the unmanaged legacy route in database authentication mode", () => {
		const result = getProviderRouteCandidates(
			{
				LLM_API_BASE_URL: "https://legacy.example/v1",
				LLM_API_KEY: "legacy-secret",
				SENKO_AUTH_MODE: "database",
			},
			MODEL_ID,
			"openai-responses",
		);
		expect(result).toEqual({
			message: "Configure SENKO_PROVIDER_ROUTES before serving database-authenticated inference requests.",
			ok: false,
		});
	});
});
