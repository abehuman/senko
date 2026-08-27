import { describe, expect, it, vi } from "vitest";
import {
	createDependencyHealthService,
	type DependencyProbes,
	databaseDependencyFromTables,
	IDENTITY_STORAGE_TABLES,
	USAGE_LEDGER_TABLES,
} from "../src/dependency-health";
import type { CloudflareBindings } from "../src/types";

const MODEL_ID = "provider/coding-model";

function env(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return {
		SENKO_ADMISSION: {} as DurableObjectNamespace,
		SENKO_API_KEY_HASH_SECRET_V1: "test-hash-secret-that-is-at-least-32-bytes-long",
		SENKO_AUTH_MODE: "database",
		SENKO_DATABASE_URL:
			"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require",
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
		SENKO_PROVIDER_KEY_OPENAI: "openai-secret",
		SENKO_PROVIDER_POOLS: {} as DurableObjectNamespace,
		SENKO_PROVIDER_ROUTES: JSON.stringify([
			{
				capacity: { max_concurrent_requests: 5, requests_per_minute: 60, tokens_per_minute: 100_000 },
				destination: "openai",
				id: "singapore-primary",
				models: { [MODEL_ID]: MODEL_ID },
				priority: 0,
				supported_protocols: ["openai-completions", "openai-responses"],
			},
		]),
		...overrides,
	};
}

function probes(overrides: Partial<DependencyProbes> = {}): DependencyProbes {
	return {
		async admission() {
			return true;
		},
		async database() {
			return { identityStorage: true, usageLedger: true };
		},
		async providerPool() {
			return true;
		},
		...overrides,
	};
}

describe("protected dependency health", () => {
	it("requires every identity and usage table instead of accepting a partial schema", () => {
		const allTables = [...IDENTITY_STORAGE_TABLES, ...USAGE_LEDGER_TABLES];
		expect(databaseDependencyFromTables(allTables)).toEqual({ identityStorage: true, usageLedger: true });
		expect(databaseDependencyFromTables(allTables.filter((table) => table !== "users"))).toEqual({
			identityStorage: false,
			usageLedger: true,
		});
		expect(databaseDependencyFromTables(allTables.filter((table) => table !== "account_usage_buckets"))).toEqual({
			identityStorage: true,
			usageLedger: false,
		});
	});

	it("checks database, admission, and each distinct configured provider pool without contacting providers", async () => {
		const providerPool = vi.fn<DependencyProbes["providerPool"]>().mockResolvedValue(true);
		const result = await createDependencyHealthService(probes({ providerPool })).check(env());

		expect(result).toEqual({
			checks: {
				admission: "ok",
				configuration: "ok",
				identity_storage: "ok",
				provider_capacity: "ok",
				usage_ledger: "ok",
			},
			status: "ok",
		});
		expect(providerPool).toHaveBeenCalledOnce();
		expect(providerPool).toHaveBeenCalledWith(expect.any(Object), "singapore-primary");
	});

	it("fails configuration without running dependency probes when staging still uses bootstrap auth", async () => {
		const admission = vi.fn<DependencyProbes["admission"]>().mockResolvedValue(true);
		const result = await createDependencyHealthService(probes({ admission })).check(
			env({ SENKO_AUTH_MODE: "bootstrap" }),
		);

		expect(result).toMatchObject({
			checks: { admission: "not_checked", configuration: "failed" },
			status: "unhealthy",
		});
		expect(admission).not.toHaveBeenCalled();
	});

	it("fails configuration without running dependency probes when the inference switch is missing", async () => {
		const admission = vi.fn<DependencyProbes["admission"]>().mockResolvedValue(true);
		const result = await createDependencyHealthService(probes({ admission })).check(
			env({ SENKO_INFERENCE_ENABLED: undefined }),
		);

		expect(result).toMatchObject({
			checks: { admission: "not_checked", configuration: "failed" },
			status: "unhealthy",
		});
		expect(admission).not.toHaveBeenCalled();
	});

	it("reports identity and ledger schema health independently", async () => {
		const result = await createDependencyHealthService(
			probes({
				async database() {
					return { identityStorage: true, usageLedger: false };
				},
			}),
		).check(env());

		expect(result).toMatchObject({
			checks: { identity_storage: "ok", usage_ledger: "failed" },
			status: "unhealthy",
		});
	});
});
