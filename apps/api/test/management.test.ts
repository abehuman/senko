import { describe, expect, it } from "vitest";
import { parseCreateAccountRequest, parseIssueApiKeyRequest, validUuid } from "../src/management";

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
});
