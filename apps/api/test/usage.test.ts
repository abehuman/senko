import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/database";
import type { CloudflareBindings, ModelPricing } from "../src/types";
import { calculateUsageCostMicrounits, createPostgresUsageService } from "../src/usage";

const DATABASE_URL =
	"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require";
const HASH_SECRET = "test-hash-secret-that-is-at-least-32-bytes-long";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ACCOUNT_ID = "00000000-0000-4000-8000-000000000004";
const KEY_ID = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";
const REQUEST_ID = "req_00000000000000000000000000000001";
const PRICING: ModelPricing = {
	currency: "USD",
	input_microunits_per_million_tokens: 2_000_000,
	output_microunits_per_million_tokens: 8_000_000,
	version: "pricing-1",
};

function env(): CloudflareBindings {
	return { SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET, SENKO_DATABASE_URL: DATABASE_URL };
}

function limits() {
	return {
		account_id: ACCOUNT_ID,
		currency: "USD",
		daily_cost_microunits: "10000000",
		max_request_cost_microunits: "1000000",
		minute_input_tokens: "100000",
		minute_output_tokens: "20000",
		monthly_cost_microunits: "100000000",
		policy_version: "policy-1",
	};
}

function keyLimits() {
	return {
		...limits(),
		api_key_id: KEY_ID,
		daily_cost_microunits: "5000000",
		max_request_cost_microunits: "500000",
		minute_input_tokens: "50000",
		minute_output_tokens: "10000",
		monthly_cost_microunits: "50000000",
		policy_version: "key-policy-1",
	};
}

function client(query: DatabaseClient["query"]): DatabaseClient {
	return {
		connect: vi.fn().mockResolvedValue(undefined),
		end: vi.fn().mockResolvedValue(undefined),
		query,
	};
}

describe("PostgreSQL usage accounting", () => {
	it("calculates exact rounded-up microunit cost", () => {
		expect(calculateUsageCostMicrounits({ inputTokens: 1, outputTokens: 1 }, PRICING)).toBe(10);
		expect(calculateUsageCostMicrounits({ inputTokens: 500_000, outputTokens: 250_000 }, PRICING)).toBe(3_000_000);
	});

	it("does not allow an account currency change that would mix aggregate buckets", async () => {
		const query = vi.fn(async (text: string, _values?: unknown[]) => {
			if (text.startsWith("select status from accounts")) return { rows: [{ status: "active" }] };
			if (text.startsWith("select currency from account_usage_limits")) return { rows: [{ currency: "JPY" }] };
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));
		await expect(
			service.configureLimits(env(), {
				accountId: ACCOUNT_ID,
				currency: "USD",
				dailyCostMicrounits: 10_000_000,
				maxRequestCostMicrounits: 1_000_000,
				minuteInputTokens: 100_000,
				minuteOutputTokens: 20_000,
				monthlyCostMicrounits: 100_000_000,
				policyVersion: "policy-2",
				requestId: REQUEST_ID,
			}),
		).resolves.toMatchObject({
			message: expect.stringContaining("currency cannot change"),
			ok: false,
			reason: "conflict",
		});
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into account_usage_limits"))).toBe(false);
		expect(query).toHaveBeenLastCalledWith("rollback");
	});

	it("configures narrower account-bound API key limits with an audit event", async () => {
		const queries: string[] = [];
		const query = vi.fn(async (text: string) => {
			queries.push(text);
			if (text.includes("from account_usage_limits") && text.includes("for update")) return { rows: [limits()] };
			if (text.startsWith("select status from api_keys")) return { rows: [{ status: "active" }] };
			if (text.includes("insert into api_key_usage_limits")) return { rows: [keyLimits()] };
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));

		await expect(
			service.configureApiKeyLimits(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				currency: "USD",
				dailyCostMicrounits: 5_000_000,
				maxRequestCostMicrounits: 500_000,
				minuteInputTokens: 50_000,
				minuteOutputTokens: 10_000,
				monthlyCostMicrounits: 50_000_000,
				policyVersion: "key-policy-1",
				requestId: REQUEST_ID,
			}),
		).resolves.toMatchObject({ ok: true, value: { accountId: ACCOUNT_ID, apiKeyId: KEY_ID } });
		expect(queries.findIndex((text) => text.includes("account_usage_limits"))).toBeLessThan(
			queries.findIndex((text) => text.includes("select status from api_keys")),
		);
		expect(queries.some((text) => text.includes("api_key_usage_limits.configured"))).toBe(true);
		expect(queries.at(-1)).toBe("commit");
	});

	it("rejects API key limits that exceed the owning account limits", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.includes("from account_usage_limits")) return { rows: [limits()] };
			if (text.startsWith("select status from api_keys")) return { rows: [{ status: "active" }] };
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));

		await expect(
			service.configureApiKeyLimits(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				currency: "USD",
				dailyCostMicrounits: 10_000_001,
				maxRequestCostMicrounits: 1_000_000,
				minuteInputTokens: 100_000,
				minuteOutputTokens: 20_000,
				monthlyCostMicrounits: 100_000_000,
				policyVersion: "key-policy-too-high",
				requestId: REQUEST_ID,
			}),
		).resolves.toMatchObject({ message: expect.stringContaining("cannot exceed"), ok: false, reason: "conflict" });
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into api_key_usage_limits"))).toBe(false);
		expect(query).toHaveBeenLastCalledWith("rollback");
	});

	it("locks account limits and all buckets before creating one reservation", async () => {
		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text.includes("from account_usage_limits") && text.includes("for update")) return { rows: [limits()] };
			if (text.includes("from usage_attempts where request_id")) return { rows: [] };
			if (text.includes("from account_usage_buckets") && text.includes("for update")) {
				return {
					rows: [
						{
							bucket_type: "minute_tokens",
							reserved_cost_microunits: "0",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{ bucket_type: "day_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
						{ bucket_type: "month_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
					],
				};
			}
			if (text.includes("insert into usage_attempts")) return { rows: [{ id: ATTEMPT_ID }] };
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));

		await expect(
			service.reserve(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				estimatedInputTokens: 100,
				pricing: PRICING,
				providerAttempt: 0,
				providerRoute: "primary",
				protocol: "openai-responses",
				requestId: REQUEST_ID,
				requestedModel: "fast",
				reservationExpiresAt: new Date(Date.now() + 60_000),
				reservedOutputTokens: 200,
				resolvedModel: "provider/model",
			}),
		).resolves.toMatchObject({ ok: true, value: { attemptId: ATTEMPT_ID } });
		expect(queries.findIndex(({ text }) => text.includes("account_usage_limits"))).toBeLessThan(
			queries.findIndex(({ text }) => text.includes("insert into usage_attempts")),
		);
		expect(queries.filter(({ text }) => text.includes("insert into usage_ledger_entries"))).toHaveLength(1);
		expect(queries.filter(({ text }) => text.includes("insert into usage_pending_reservations"))).toHaveLength(1);
		expect(queries.at(-1)?.text).toBe("commit");
	});

	it("returns the original reservation idempotently even after the current limit is lowered", async () => {
		const loweredLimits = { ...limits(), max_request_cost_microunits: "1" };
		const query = vi.fn(async (text: string) => {
			if (text.includes("from account_usage_limits")) return { rows: [loweredLimits] };
			if (text.includes("from usage_attempts where request_id")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							api_key_id: KEY_ID,
							api_key_policy_version: "key-policy-1",
							currency: "USD",
							estimated_input_tokens: "100",
							id: ATTEMPT_ID,
							input_price_microunits_per_million_tokens: "2000000",
							output_price_microunits_per_million_tokens: "8000000",
							pricing_version: "pricing-1",
							provider_attempt: 0,
							provider_route: "primary",
							protocol: "openai-responses",
							request_id: REQUEST_ID,
							requested_model: "fast",
							reserved_cost_microunits: "1800",
							reserved_output_tokens: "200",
							resolved_model: "provider/model",
						},
					],
				};
			}
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));
		await expect(
			service.reserve(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				estimatedInputTokens: 100,
				pricing: PRICING,
				providerAttempt: 0,
				providerRoute: "primary",
				protocol: "openai-responses",
				requestId: REQUEST_ID,
				requestedModel: "fast",
				reservationExpiresAt: new Date(Date.now() + 60_000),
				reservedOutputTokens: 200,
				resolvedModel: "provider/model",
			}),
		).resolves.toMatchObject({ ok: true, value: { attemptId: ATTEMPT_ID, reservedCostMicrounits: 1800 } });
		expect(query.mock.calls.some(([text]) => String(text).includes("account_usage_buckets"))).toBe(false);
	});

	it("fails closed before inserting an attempt when a token bucket is exhausted", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.includes("from account_usage_limits")) return { rows: [limits()] };
			if (text.includes("from usage_attempts where request_id")) return { rows: [] };
			if (text.includes("from account_usage_buckets") && text.includes("for update")) {
				return {
					rows: [
						{
							bucket_type: "minute_tokens",
							reserved_input_tokens: "99999",
							reserved_output_tokens: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{ bucket_type: "day_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
						{ bucket_type: "month_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
					],
				};
			}
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));
		await expect(
			service.reserve(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				estimatedInputTokens: 2,
				pricing: PRICING,
				providerAttempt: 0,
				providerRoute: "primary",
				protocol: "openai-responses",
				requestId: REQUEST_ID,
				requestedModel: "fast",
				reservationExpiresAt: new Date(Date.now() + 60_000),
				reservedOutputTokens: 1,
				resolvedModel: "provider/model",
			}),
		).resolves.toEqual({ dimension: "minute_input_tokens", ok: false, reason: "limit_exceeded" });
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into usage_attempts"))).toBe(false);
		expect(query).toHaveBeenLastCalledWith("rollback");
	});

	it("fails closed when the API key token bucket is exhausted even if the account has capacity", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.includes("from account_usage_limits")) return { rows: [limits()] };
			if (text.includes("from api_key_usage_limits")) {
				return { rows: [{ ...keyLimits(), minute_input_tokens: "100" }] };
			}
			if (text.includes("from usage_attempts where request_id")) return { rows: [] };
			if (text.includes("from account_usage_buckets") && text.includes("for update")) {
				return {
					rows: [
						{
							bucket_type: "minute_tokens",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{ bucket_type: "day_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
						{ bucket_type: "month_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
					],
				};
			}
			if (text.includes("from api_key_usage_buckets") && text.includes("for update")) {
				return {
					rows: [
						{
							bucket_type: "minute_tokens",
							reserved_input_tokens: "99",
							reserved_output_tokens: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{ bucket_type: "day_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
						{ bucket_type: "month_cost", reserved_cost_microunits: "0", settled_cost_microunits: "0" },
					],
				};
			}
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));
		await expect(
			service.reserve(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				estimatedInputTokens: 2,
				pricing: PRICING,
				providerAttempt: 0,
				providerRoute: "primary",
				protocol: "openai-responses",
				requestId: REQUEST_ID,
				requestedModel: "fast",
				reservationExpiresAt: new Date(Date.now() + 60_000),
				reservedOutputTokens: 1,
				resolvedModel: "provider/model",
			}),
		).resolves.toEqual({ dimension: "minute_input_tokens", ok: false, reason: "limit_exceeded" });
		expect(query.mock.calls.some(([text]) => String(text).includes("insert into usage_attempts"))).toBe(false);
		expect(query).toHaveBeenLastCalledWith("rollback");
	});

	it("conservatively settles the full reservation when provider usage is missing", async () => {
		const queries: Array<{ text: string; values?: unknown[] }> = [];
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			queries.push({ text, values });
			if (text.includes("from usage_attempts where id")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							api_key_id: KEY_ID,
							api_key_policy_version: "key-policy-1",
							currency: "USD",
							day_window_start: "2026-08-25T00:00:00.000Z",
							estimated_input_tokens: "100",
							id: ATTEMPT_ID,
							input_price_microunits_per_million_tokens: "2000000",
							minute_window_start: "2026-08-25T01:02:00.000Z",
							month_window_start: "2026-08-01T00:00:00.000Z",
							output_price_microunits_per_million_tokens: "8000000",
							pricing_version: "pricing-1",
							reserved_cost_microunits: "1800",
							reserved_output_tokens: "200",
						},
					],
				};
			}
			if (text.includes("from usage_ledger_entries")) return { rows: [] };
			if (text.includes("from api_key_usage_buckets") && text.includes("for update")) {
				return {
					rows: [
						{
							bucket_type: "minute_tokens",
							reserved_cost_microunits: "0",
							reserved_input_tokens: "100",
							reserved_output_tokens: "200",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{
							bucket_type: "day_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{
							bucket_type: "month_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
					],
				};
			}
			if (text.includes("from account_usage_buckets") && text.includes("for update")) {
				return {
					rows: [
						{
							bucket_type: "minute_tokens",
							reserved_cost_microunits: "0",
							reserved_input_tokens: "100",
							reserved_output_tokens: "200",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{
							bucket_type: "day_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
						{
							bucket_type: "month_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
						},
					],
				};
			}
			if (text.includes("from api_key_usage_limits")) return { rows: [keyLimits()] };
			if (text.includes("from account_usage_limits")) return { rows: [limits()] };
			return { rowCount: 1, rows: [] };
		});
		const service = createPostgresUsageService(() => client(query as unknown as DatabaseClient["query"]));
		await expect(
			service.finalize(env(), {
				accountId: ACCOUNT_ID,
				attemptId: ATTEMPT_ID,
				kind: "conservative_settled",
				terminalReason: "missing_provider_usage",
			}),
		).resolves.toEqual({ ok: true, value: { overLimitAfterSettlement: false, settledCostMicrounits: 1800 } });
		const terminal = queries.find(({ text }) => text.includes("insert into usage_ledger_entries"));
		expect(terminal?.values).toEqual([
			ATTEMPT_ID,
			ACCOUNT_ID,
			"conservative_settled",
			100,
			200,
			1800,
			100,
			200,
			1800,
			"reservation",
			"missing_provider_usage",
		]);
		expect(queries.filter(({ text }) => text.includes("update api_key_usage_buckets"))).toHaveLength(3);
	});

	it("claims and settles expired reservations in one skip-locked transaction", async () => {
		const query = vi.fn(async (text: string, _values?: unknown[]) => {
			if (text.includes("from usage_pending_reservations p")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							api_key_id: KEY_ID,
							api_key_policy_version: "key-policy-1",
							attempt_id: ATTEMPT_ID,
							day_window_start: "2026-08-25T00:00:00.000Z",
							estimated_input_tokens: "100",
							minute_window_start: "2026-08-25T01:02:00.000Z",
							month_window_start: "2026-08-01T00:00:00.000Z",
							reserved_cost_microunits: "1800",
							reserved_output_tokens: "200",
						},
						{
							account_id: SECOND_ACCOUNT_ID,
							api_key_id: "00000000-0000-4000-8000-000000000006",
							api_key_policy_version: null,
							attempt_id: "00000000-0000-4000-8000-000000000005",
							day_window_start: "2026-08-25T00:00:00.000Z",
							estimated_input_tokens: "50",
							minute_window_start: "2026-08-25T01:03:00.000Z",
							month_window_start: "2026-08-01T00:00:00.000Z",
							reserved_cost_microunits: "900",
							reserved_output_tokens: "100",
						},
					],
				};
			}
			if (text.startsWith("select b.api_key_id")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							api_key_id: KEY_ID,
							bucket_type: "month_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-01T00:00:00.000Z",
						},
						{
							account_id: ACCOUNT_ID,
							api_key_id: KEY_ID,
							bucket_type: "day_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-25T00:00:00.000Z",
						},
						{
							account_id: ACCOUNT_ID,
							api_key_id: KEY_ID,
							bucket_type: "minute_tokens",
							reserved_cost_microunits: "0",
							reserved_input_tokens: "100",
							reserved_output_tokens: "200",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-25T01:02:00.000Z",
						},
					],
				};
			}
			if (text.startsWith("select b.account_id")) {
				return {
					rows: [
						{
							account_id: ACCOUNT_ID,
							bucket_type: "month_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-01T00:00:00.000Z",
						},
						{
							account_id: ACCOUNT_ID,
							bucket_type: "day_cost",
							reserved_cost_microunits: "1800",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-25T00:00:00.000Z",
						},
						{
							account_id: ACCOUNT_ID,
							bucket_type: "minute_tokens",
							reserved_cost_microunits: "0",
							reserved_input_tokens: "100",
							reserved_output_tokens: "200",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-25T01:02:00.000Z",
						},
						{
							account_id: SECOND_ACCOUNT_ID,
							bucket_type: "month_cost",
							reserved_cost_microunits: "900",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-01T00:00:00.000Z",
						},
						{
							account_id: SECOND_ACCOUNT_ID,
							bucket_type: "day_cost",
							reserved_cost_microunits: "900",
							reserved_input_tokens: "0",
							reserved_output_tokens: "0",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-25T00:00:00.000Z",
						},
						{
							account_id: SECOND_ACCOUNT_ID,
							bucket_type: "minute_tokens",
							reserved_cost_microunits: "0",
							reserved_input_tokens: "50",
							reserved_output_tokens: "100",
							settled_cost_microunits: "0",
							settled_input_tokens: "0",
							settled_output_tokens: "0",
							window_start: "2026-08-25T01:03:00.000Z",
						},
					],
				};
			}
			if (text.startsWith("update account_usage_buckets")) return { rowCount: 6, rows: [] };
			if (text.startsWith("update api_key_usage_buckets")) return { rowCount: 3, rows: [] };
			if (text.includes("insert into usage_ledger_entries")) return { rowCount: 2, rows: [] };
			if (text.startsWith("delete from usage_pending_reservations")) return { rowCount: 2, rows: [] };
			return { rowCount: 1, rows: [] };
		});
		const factory = vi.fn(() => client(query as unknown as DatabaseClient["query"]));
		const service = createPostgresUsageService(factory);

		await expect(service.reconcileExpired(env(), 10)).resolves.toEqual({
			ok: true,
			value: { candidates: 2, failed: 0, settled: 2, skipped: 0 },
		});
		expect(factory).toHaveBeenCalledOnce();
		expect(query).toHaveBeenCalledWith(expect.stringContaining("for update of p skip locked"), [10]);
		expect(query).toHaveBeenCalledWith(
			expect.stringMatching(
				/order by b\.account_id,\s+case b\.bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end,\s+b\.window_start\s+for update of b/,
			),
			expect.any(Array),
		);
		const bucketLockCall = query.mock.calls.find(([text]) => String(text).startsWith("select b.account_id"));
		const bucketLockParameters = bucketLockCall?.[1] ?? [];
		expect(Array.from({ length: 6 }, (_, index) => bucketLockParameters[index * 6 + 1])).toEqual([
			"minute_tokens",
			"day_cost",
			"month_cost",
			"minute_tokens",
			"day_cost",
			"month_cost",
		]);
		expect(query.mock.calls.some(([text]) => String(text).includes("not exists"))).toBe(false);
		expect(query.mock.calls.some(([text]) => String(text).startsWith("update api_key_usage_buckets"))).toBe(true);
		expect(query).toHaveBeenLastCalledWith("commit");
	});
});
