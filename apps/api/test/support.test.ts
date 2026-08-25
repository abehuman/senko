import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/database";
import { createPostgresSupportService, validRequestId } from "../src/support";
import type { CloudflareBindings } from "../src/types";

const DATABASE_URL =
	"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require";
const HASH_SECRET = "test-hash-secret-that-is-at-least-32-bytes-long";
const REQUEST_ID = "req_00000000000000000000000000000001";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const KEY_ID = "00000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000003";

function env(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
	return { SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET, SENKO_DATABASE_URL: DATABASE_URL, ...overrides };
}

function client(query: DatabaseClient["query"]): DatabaseClient {
	return {
		connect: vi.fn().mockResolvedValue(undefined),
		end: vi.fn().mockResolvedValue(undefined),
		query,
	};
}

function attemptRow() {
	return {
		account_id: ACCOUNT_ID,
		api_key_id: KEY_ID,
		created_at: "2026-08-24T00:00:00.000Z",
		currency: "USD",
		estimated_input_tokens: "12",
		id: ATTEMPT_ID,
		policy_version: "policy-1",
		pricing_version: "pricing-1",
		protocol: "openai-responses",
		provider_attempt: 0,
		provider_route: "primary",
		requested_model: "fast",
		reservation_expires_at: "2026-08-24T00:02:00.000Z",
		reserved_cost_microunits: "100",
		reserved_output_tokens: "20",
		resolved_model: "provider/model",
	};
}

function ledgerRow() {
	return {
		attempt_id: ATTEMPT_ID,
		created_at: "2026-08-24T00:01:00.000Z",
		event_type: "settlement",
		phase: "settlement",
		released_cost_microunits: "0",
		released_input_tokens: "0",
		released_output_tokens: "0",
		reserved_cost_microunits: "0",
		reserved_input_tokens: "0",
		reserved_output_tokens: "0",
		settled_cost_microunits: "80",
		settled_input_tokens: "12",
		settled_output_tokens: "8",
		terminal_reason: "completed",
		usage_source: "provider",
	};
}

function traceRow() {
	return {
		account_id: ACCOUNT_ID,
		api_key_id: KEY_ID,
		completed_at: "2026-08-24T00:01:00.000Z",
		endpoint: "responses",
		failure_category: null,
		http_status: 200,
		method: "POST",
		request_id: REQUEST_ID,
		started_at: "2026-08-24T00:00:00.000Z",
	};
}

function objectKeys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(objectKeys);
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, nested]) => [key, ...objectKeys(nested)]);
}

describe("PostgreSQL request support lookup", () => {
	it("accepts only generated Senko request IDs", () => {
		expect(validRequestId(REQUEST_ID)).toBe(true);
		expect(validRequestId("req_0000000000000000000000000000000A")).toBe(false);
		expect(validRequestId("customer-selected-id")).toBe(false);
	});

	it("returns bounded content-free routing and usage metadata", async () => {
		const query = vi.fn(async (text: string, values?: unknown[]) => {
			if (text.includes("from request_traces")) return { rows: [traceRow()] };
			if (text.includes("from usage_attempts")) {
				expect(values).toEqual([REQUEST_ID, 17]);
				return { rows: [attemptRow()] };
			}
			if (text.includes("from usage_ledger_entries")) return { rows: [ledgerRow()] };
			if (text.includes("from usage_pending_reservations")) return { rows: [{ attempt_id: ATTEMPT_ID }] };
			return { rows: [] };
		});
		const service = createPostgresSupportService(() => client(query as unknown as DatabaseClient["query"]));

		const result = await service.lookupRequest(env(), REQUEST_ID);

		expect(result).toEqual({
			ok: true,
			value: {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				attempts: [
					{
						accountId: ACCOUNT_ID,
						apiKeyId: KEY_ID,
						attemptId: ATTEMPT_ID,
						createdAt: "2026-08-24T00:00:00.000Z",
						currency: "USD",
						estimatedInputTokens: 12,
						ledger: [
							{
								createdAt: "2026-08-24T00:01:00.000Z",
								eventType: "settlement",
								phase: "settlement",
								releasedCostMicrounits: 0,
								releasedInputTokens: 0,
								releasedOutputTokens: 0,
								reservedCostMicrounits: 0,
								reservedInputTokens: 0,
								reservedOutputTokens: 0,
								settledCostMicrounits: 80,
								settledInputTokens: 12,
								settledOutputTokens: 8,
								terminalReason: "completed",
								usageSource: "provider",
							},
						],
						pendingReservation: true,
						policyVersion: "policy-1",
						pricingVersion: "pricing-1",
						protocol: "openai-responses",
						providerAttempt: 0,
						providerRoute: "primary",
						requestedModel: "fast",
						reservationExpiresAt: "2026-08-24T00:02:00.000Z",
						reservedCostMicrounits: 100,
						reservedOutputTokens: 20,
						resolvedModel: "provider/model",
					},
				],
				completedAt: "2026-08-24T00:01:00.000Z",
				endpoint: "responses",
				failureCategory: null,
				hasMore: false,
				httpStatus: 200,
				method: "POST",
				requestId: REQUEST_ID,
				startedAt: "2026-08-24T00:00:00.000Z",
			},
		});
		const keys = objectKeys(result).map((key) => key.toLowerCase());
		for (const forbidden of [
			"prompt",
			"input",
			"output",
			"messages",
			"instructions",
			"tools",
			"authorization",
			"key_hash",
		]) {
			expect(keys).not.toContain(forbidden);
		}
		expect(query.mock.calls.map(([text]) => String(text))).toEqual([
			"begin transaction isolation level repeatable read read only",
			expect.stringContaining("from request_traces"),
			expect.stringContaining("from usage_attempts"),
			expect.stringContaining("from usage_ledger_entries"),
			expect.stringContaining("from usage_pending_reservations"),
			"commit",
		]);
	});

	it("returns a failed pre-reservation request with no usage attempts", async () => {
		const query = vi.fn(async (text: string) => {
			if (text.includes("from request_traces")) {
				return {
					rows: [
						{
							...traceRow(),
							completed_at: "2026-08-24T00:00:01.000Z",
							failure_category: "usage",
							http_status: 503,
						},
					],
				};
			}
			if (text.includes("from usage_attempts")) return { rows: [] };
			return { rows: [] };
		});
		const service = createPostgresSupportService(() => client(query as unknown as DatabaseClient["query"]));

		await expect(service.lookupRequest(env(), REQUEST_ID)).resolves.toMatchObject({
			ok: true,
			value: { attempts: [], failureCategory: "usage", hasMore: false, httpStatus: 503, requestId: REQUEST_ID },
		});
		expect(query.mock.calls.map(([text]) => String(text))).toEqual([
			"begin transaction isolation level repeatable read read only",
			expect.stringContaining("from request_traces"),
			expect.stringContaining("from usage_attempts"),
			"commit",
		]);
	});

	it("returns not found when the independent request envelope is absent", async () => {
		const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
		const service = createPostgresSupportService(() => client(query as unknown as DatabaseClient["query"]));

		await expect(service.lookupRequest(env(), REQUEST_ID)).resolves.toEqual({ ok: false, reason: "not_found" });
		expect(query.mock.calls.map(([text]) => String(text))).toEqual([
			"begin transaction isolation level repeatable read read only",
			expect.stringContaining("from request_traces"),
			"commit",
		]);
	});

	it("records a content-free final request envelope idempotently", async () => {
		const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
		const service = createPostgresSupportService(() => client(query as unknown as DatabaseClient["query"]));

		await expect(
			service.recordRequest(env(), {
				accountId: ACCOUNT_ID,
				apiKeyId: KEY_ID,
				completedAt: new Date("2026-08-24T00:01:00.000Z"),
				endpoint: "responses",
				httpStatus: 503,
				failureCategory: "usage",
				method: "POST",
				requestId: REQUEST_ID,
				startedAt: new Date("2026-08-24T00:00:00.000Z"),
			}),
		).resolves.toEqual({ ok: true, value: undefined });
		expect(query).toHaveBeenCalledWith(expect.stringContaining("insert into request_traces"), [
			REQUEST_ID,
			ACCOUNT_ID,
			KEY_ID,
			"responses",
			"POST",
			503,
			"usage",
			new Date("2026-08-24T00:00:00.000Z"),
			new Date("2026-08-24T00:01:00.000Z"),
		]);
		expect(String(query.mock.calls[0]?.[0])).toContain("on conflict (request_id) do nothing");
	});

	it("fails closed on configuration, storage, or unsafe numeric data", async () => {
		const factory = vi.fn();
		const service = createPostgresSupportService(factory);
		await expect(service.lookupRequest({}, REQUEST_ID)).resolves.toMatchObject({
			ok: false,
			reason: "configuration_error",
		});
		expect(factory).not.toHaveBeenCalled();

		const query = vi.fn(async (text: string) => {
			if (text.includes("from request_traces")) return { rows: [traceRow()] };
			if (text.includes("from usage_attempts")) {
				return { rows: [{ ...attemptRow(), reserved_cost_microunits: "9007199254740992" }] };
			}
			if (text.includes("from usage_ledger_entries")) return { rows: [] };
			if (text.includes("from usage_pending_reservations")) return { rows: [] };
			return { rows: [] };
		});
		const unsafe = createPostgresSupportService(() => client(query as unknown as DatabaseClient["query"]));
		await expect(unsafe.lookupRequest(env(), REQUEST_ID)).resolves.toEqual({ ok: false, reason: "unavailable" });
		expect(query).toHaveBeenLastCalledWith("rollback");
	});
});
