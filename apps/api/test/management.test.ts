import { describe, expect, it } from "vitest";
import {
	parseConfigureUsageLimitsRequest,
	parseCreateAccountRequest,
	parseCreateTeamRequest,
	parseIssueApiKeyRequest,
	parseListAccountsRequest,
	parseListApiKeysRequest,
	parseListAuditEventsRequest,
	parseListTeamsRequest,
	parseRotateApiKeyRequest,
	validUuid,
} from "../src/management";

describe("identity management request validation", () => {
	it("accepts a minimal account and defaults its plan", () => {
		expect(parseCreateAccountRequest({ name: "Senko Test" })).toEqual({
			ok: true,
			value: { name: "Senko Test", planKey: "beta" },
		});
	});

	it("rejects unknown account and key fields", () => {
		expect(parseCreateAccountRequest({ name: "Test", status: "active" })).toMatchObject({
			code: "unsupported_parameter",
			ok: false,
			param: "status",
		});
		expect(parseIssueApiKeyRequest({ key: "chosen-by-client", name: "CLI", scopes: ["models:read"] })).toMatchObject({
			code: "unsupported_parameter",
			ok: false,
			param: "key",
		});
	});

	it("accepts a bounded team name and rejects client-selected ownership", () => {
		expect(parseCreateTeamRequest({ name: " Platform " })).toEqual({
			ok: true,
			value: { name: "Platform" },
		});
		expect(parseCreateTeamRequest({ account_id: "client-selected", name: "Platform" })).toMatchObject({
			code: "unsupported_parameter",
			ok: false,
			param: "account_id",
		});
	});

	it("validates scopes, ownership identifiers, and future expiry", () => {
		const now = new Date("2026-08-24T00:00:00.000Z");
		expect(
			parseIssueApiKeyRequest(
				{
					expires_at: "2026-09-24T00:00:00.000Z",
					name: "CLI",
					scopes: ["models:read", "inference:responses", "models:read"],
					team_id: null,
				},
				now,
			),
		).toMatchObject({
			ok: true,
			value: { name: "CLI", scopes: ["models:read", "inference:responses"], teamId: null },
		});
		expect(parseIssueApiKeyRequest({ name: "CLI", scopes: ["admin:write"] }, now)).toMatchObject({
			code: "invalid_scopes",
			ok: false,
		});
		expect(
			parseIssueApiKeyRequest({ expires_at: "2026-08-23T00:00:00.000Z", name: "CLI", scopes: ["models:read"] }, now),
		).toMatchObject({ code: "invalid_expiry", ok: false });
		expect(validUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
		expect(validUuid("not-an-id")).toBe(false);
	});

	it("validates explicit account usage-limit policies", () => {
		expect(
			parseConfigureUsageLimitsRequest({
				currency: "USD",
				daily_cost_microunits: 10_000_000,
				max_request_cost_microunits: 1_000_000,
				minute_input_tokens: 100_000,
				minute_output_tokens: 20_000,
				monthly_cost_microunits: 100_000_000,
				policy_version: "beta-2026-08",
			}),
		).toMatchObject({
			ok: true,
			value: { currency: "USD", policyVersion: "beta-2026-08" },
		});
		expect(
			parseConfigureUsageLimitsRequest({
				currency: "usd",
				daily_cost_microunits: 100,
				max_request_cost_microunits: 200,
				minute_input_tokens: 1,
				minute_output_tokens: 1,
				monthly_cost_microunits: 300,
				policy_version: "beta",
			}),
		).toMatchObject({ code: "invalid_currency", ok: false });
	});

	it("bounds API key listing and validates its cursor", () => {
		expect(parseListApiKeysRequest(undefined, undefined)).toEqual({
			ok: true,
			value: { limit: 50, startingAfter: null },
		});
		expect(parseListApiKeysRequest("100", "00000000-0000-4000-8000-000000000001")).toMatchObject({
			ok: true,
			value: { limit: 100, startingAfter: "00000000-0000-4000-8000-000000000001" },
		});
		expect(parseListApiKeysRequest("101", undefined)).toMatchObject({ code: "invalid_limit", ok: false });
		expect(parseListApiKeysRequest(undefined, "another-account-key")).toMatchObject({
			code: "invalid_starting_after",
			ok: false,
		});
	});

	it("bounds account listing and validates its cursor", () => {
		expect(parseListAccountsRequest(undefined, undefined)).toEqual({
			ok: true,
			value: { limit: 50, startingAfter: null },
		});
		expect(parseListAccountsRequest("100", "00000000-0000-4000-8000-000000000001")).toMatchObject({
			ok: true,
			value: { limit: 100, startingAfter: "00000000-0000-4000-8000-000000000001" },
		});
		expect(parseListAccountsRequest("0", undefined)).toMatchObject({ code: "invalid_limit", ok: false });
		expect(parseListAccountsRequest(undefined, "another-account")).toMatchObject({
			code: "invalid_starting_after",
			ok: false,
		});
	});

	it("bounds team listing and validates its cursor", () => {
		expect(parseListTeamsRequest(undefined, undefined)).toEqual({
			ok: true,
			value: { limit: 50, startingAfter: null },
		});
		expect(parseListTeamsRequest("100", "00000000-0000-4000-8000-000000000001")).toMatchObject({
			ok: true,
			value: { limit: 100, startingAfter: "00000000-0000-4000-8000-000000000001" },
		});
		expect(parseListTeamsRequest("0", undefined)).toMatchObject({ code: "invalid_limit", ok: false });
		expect(parseListTeamsRequest(undefined, "another-account-team")).toMatchObject({
			code: "invalid_starting_after",
			ok: false,
			param: "starting_after",
		});
	});

	it("bounds audit event listing and validates its cursor", () => {
		expect(parseListAuditEventsRequest(undefined, undefined)).toEqual({
			ok: true,
			value: { limit: 50, startingAfter: null },
		});
		expect(parseListAuditEventsRequest("25", "00000000-0000-4000-8000-000000000001")).toMatchObject({
			ok: true,
			value: { limit: 25, startingAfter: "00000000-0000-4000-8000-000000000001" },
		});
		expect(parseListAuditEventsRequest("101", undefined)).toMatchObject({ code: "invalid_limit", ok: false });
		expect(parseListAuditEventsRequest(undefined, "another-account-event")).toMatchObject({
			code: "invalid_starting_after",
			ok: false,
		});
	});

	it("allows bounded rotation overrides without client-selected scopes", () => {
		const now = new Date("2026-08-24T00:00:00.000Z");
		expect(parseRotateApiKeyRequest({}, now)).toEqual({ ok: true, value: {} });
		expect(parseRotateApiKeyRequest({ expires_at: "2026-09-24T00:00:00.000Z", name: "CLI next" }, now)).toMatchObject({
			ok: true,
			value: { name: "CLI next" },
		});
		expect(parseRotateApiKeyRequest({ scopes: ["models:read"] }, now)).toMatchObject({
			code: "unsupported_parameter",
			ok: false,
			param: "scopes",
		});
	});
});
