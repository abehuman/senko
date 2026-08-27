import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openApiDocument } from "../src/openapi";
import { CHAT_REQUEST_FIELDS, RESPONSES_REQUEST_FIELDS } from "../src/request-policy";

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
	return value as Record<string, unknown>;
}

function operation(path: string, method: string): Record<string, unknown> {
	return record(record(record(openApiDocument).paths)[path])[method] as Record<string, unknown>;
}

function schema(name: string): Record<string, unknown> {
	return record(record(record(record(openApiDocument).components).schemas)[name]);
}

describe("Senko OpenAPI contract", () => {
	it("publishes the versioned document without authentication", async () => {
		const response = await createApp().request("/openapi.json", {}, {});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("x-request-id")).toMatch(/^req_[a-f0-9]{32}$/);
		expect(await response.json()).toMatchObject({
			info: { title: "Senko API", version: "0.1.0" },
			openapi: "3.1.0",
		});
	});

	it("documents every implemented route and method exactly once", () => {
		const expected = {
			"/": ["get"],
			"/admin/v1/accounts": ["get", "post"],
			"/admin/v1/accounts/{accountId}/audit-events": ["get"],
			"/admin/v1/accounts/{accountId}/reactivate": ["post"],
			"/admin/v1/accounts/{accountId}/suspend": ["post"],
			"/admin/v1/accounts/{accountId}/teams": ["get", "post"],
			"/admin/v1/accounts/{accountId}/teams/{teamId}/archive": ["post"],
			"/admin/v1/accounts/{accountId}/teams/{teamId}/reactivate": ["post"],
			"/admin/v1/accounts/{accountId}/api-keys": ["get", "post"],
			"/admin/v1/accounts/{accountId}/api-keys/{keyId}/rotate": ["post"],
			"/admin/v1/accounts/{accountId}/api-keys/{keyId}/revoke": ["post"],
			"/admin/v1/accounts/{accountId}/api-keys/{keyId}/usage-limits": ["put"],
			"/admin/v1/accounts/{accountId}/usage-limits": ["put"],
			"/admin/v1/dependency-health": ["get"],
			"/admin/v1/requests/{requestId}": ["get"],
			"/health": ["get"],
			"/openapi.json": ["get"],
			"/v1/chat/completions": ["post"],
			"/v1/models": ["get"],
			"/v1/responses": ["post"],
		};
		const paths = record(record(openApiDocument).paths);
		expect(Object.keys(paths).sort()).toEqual(Object.keys(expected).sort());
		for (const [path, methods] of Object.entries(expected)) {
			expect(Object.keys(record(paths[path])).sort()).toEqual(methods);
		}
		const operationIds = Object.entries(paths).flatMap(([path, pathItem]) =>
			Object.keys(record(pathItem)).map((method) => operation(path, method).operationId),
		);
		expect(new Set(operationIds).size).toBe(operationIds.length);
	});

	it("separates public, customer-key, and operator authentication", () => {
		for (const path of ["/", "/health", "/openapi.json"]) {
			expect(operation(path, "get").security).toEqual([]);
		}
		for (const [path, method] of [
			["/v1/models", "get"],
			["/v1/chat/completions", "post"],
			["/v1/responses", "post"],
		] as const) {
			expect(operation(path, method).security).toEqual([{ SenkoApiKey: [] }]);
		}
		for (const [path, method] of [
			["/admin/v1/dependency-health", "get"],
			["/admin/v1/requests/{requestId}", "get"],
			["/admin/v1/accounts", "get"],
			["/admin/v1/accounts", "post"],
			["/admin/v1/accounts/{accountId}/audit-events", "get"],
			["/admin/v1/accounts/{accountId}/reactivate", "post"],
			["/admin/v1/accounts/{accountId}/suspend", "post"],
			["/admin/v1/accounts/{accountId}/teams", "post"],
			["/admin/v1/accounts/{accountId}/teams", "get"],
			["/admin/v1/accounts/{accountId}/teams/{teamId}/archive", "post"],
			["/admin/v1/accounts/{accountId}/teams/{teamId}/reactivate", "post"],
			["/admin/v1/accounts/{accountId}/api-keys", "get"],
			["/admin/v1/accounts/{accountId}/api-keys", "post"],
			["/admin/v1/accounts/{accountId}/api-keys/{keyId}/rotate", "post"],
			["/admin/v1/accounts/{accountId}/api-keys/{keyId}/revoke", "post"],
			["/admin/v1/accounts/{accountId}/api-keys/{keyId}/usage-limits", "put"],
			["/admin/v1/accounts/{accountId}/usage-limits", "put"],
		] as const) {
			expect(operation(path, method).security).toEqual([{ SenkoAdminToken: [] }]);
		}
		expect(operation("/v1/models", "get")["x-senko-required-scope"]).toBe("models:read");
		expect(operation("/v1/chat/completions", "post")["x-senko-required-scope"]).toBe("inference:chat");
		expect(operation("/v1/responses", "post")["x-senko-required-scope"]).toBe("inference:responses");
	});

	it("keeps inference request fields aligned with the runtime allowlists", () => {
		expect(Object.keys(record(schema("ChatCompletionRequest").properties)).sort()).toEqual(
			[...CHAT_REQUEST_FIELDS].sort(),
		);
		expect(Object.keys(record(schema("ResponsesRequest").properties)).sort()).toEqual(
			[...RESPONSES_REQUEST_FIELDS].sort(),
		);
		expect(schema("ChatCompletionRequest").additionalProperties).toBe(false);
		expect(schema("ResponsesRequest").additionalProperties).toBe(false);
	});

	it("documents nested inference inputs and normalized JSON success envelopes", () => {
		const chatRequest = record(schema("ChatCompletionRequest").properties);
		expect(record(record(chatRequest.messages).items)).toEqual({ $ref: "#/components/schemas/ChatMessage" });
		const responsesInput = record(record(schema("ResponsesRequest").properties).input);
		const responseArray = (responsesInput.oneOf as unknown[])
			.map(record)
			.find((candidate) => candidate.type === "array");
		expect(record(responseArray?.items)).toEqual({ $ref: "#/components/schemas/ResponsesInputItem" });
		expect(schema("FunctionTool")).toMatchObject({ additionalProperties: false, required: ["function", "type"] });

		for (const [path, expectedRef] of [
			["/v1/chat/completions", "#/components/schemas/ChatCompletion"],
			["/v1/responses", "#/components/schemas/Response"],
		] as const) {
			const responses = record(operation(path, "post").responses);
			const content = record(record(responses["200"]).content);
			expect(record(record(content["application/json"]).schema)).toEqual({ $ref: expectedRef });
		}

		const chatCompletion = schema("ChatCompletion");
		const choice = record(record(record(chatCompletion.properties).choices).items);
		expect(record(record(choice.properties).index)).toEqual({ const: 0 });
		expect(record(chatCompletion.properties).usage).toBeDefined();
		const response = schema("Response");
		expect(record(record(response.properties).output).items).toBeDefined();
		expect(record(record(response.properties).status).enum).toEqual(["completed", "failed", "incomplete"]);
		expect(response.allOf).toBeDefined();
	});

	it("documents management allowlists and does not expose secret binding names", () => {
		expect(Object.keys(record(schema("CreateAccountRequest").properties)).sort()).toEqual(["name", "plan_key"]);
		expect(Object.keys(record(schema("CreateTeamRequest").properties))).toEqual(["name"]);
		expect(Object.keys(record(schema("Account").properties))).toEqual(
			expect.arrayContaining(["id", "status", "suspended_at"]),
		);
		expect(Object.keys(record(schema("Team").properties))).toEqual(
			expect.arrayContaining(["account_id", "id", "name", "status"]),
		);
		expect(Object.keys(record(schema("AuditEvent").properties))).not.toContain("metadata");
		expect(Object.keys(record(schema("AuditEvent").properties))).not.toContain("actor_user_id");
		expect(Object.keys(record(schema("AuditEvent").properties))).not.toContain("actor_api_key_id");
		expect(Object.keys(record(schema("IssueApiKeyRequest").properties)).sort()).toEqual([
			"expires_at",
			"name",
			"scopes",
			"team_id",
		]);
		expect(Object.keys(record(schema("RotateApiKeyRequest").properties)).sort()).toEqual(["expires_at", "name"]);
		expect(Object.keys(record(schema("ApiKey").properties))).not.toContain("key");
		expect(Object.keys(record(schema("ApiKey").properties))).not.toContain("key_hash");
		const issuedProperties = Object.keys(record(schema("IssuedApiKey").properties));
		expect(issuedProperties.sort()).toEqual(
			[...Object.keys(record(schema("ApiKey").properties)), "key", "warning"].sort(),
		);
		expect(schema("IssuedApiKey").additionalProperties).toBe(false);
		expect(schema("IssuedApiKey")).not.toHaveProperty("allOf");
		expect(Object.keys(record(schema("UsageLimitsRequest").properties)).sort()).toEqual([
			"currency",
			"daily_cost_microunits",
			"max_request_cost_microunits",
			"minute_input_tokens",
			"minute_output_tokens",
			"monthly_cost_microunits",
			"policy_version",
		]);
		expect(schema("UsageLimits")).not.toHaveProperty("allOf");
		expect(schema("ApiKeyUsageLimits")).not.toHaveProperty("allOf");
		expect(Object.keys(record(schema("ApiKeyUsageLimits").properties))).toEqual(
			expect.arrayContaining(["account_id", "api_key_id", "object"]),
		);
		const serialized = JSON.stringify(openApiDocument);
		expect(serialized).not.toContain("SENKO_ADMIN_TOKEN");
		expect(serialized).not.toContain("SENKO_PROVIDER_KEY_");
		expect(serialized).not.toContain("LLM_API_KEY");
		expect(serialized).not.toContain("DATABASE_URL");
	});

	it("keeps support traces content-free and bounded", () => {
		expect(record(schema("RequestTrace").properties).attempts).toMatchObject({ maxItems: 16, type: "array" });
		const schemaNames = ["RequestTrace", "RequestAttemptTrace", "RequestLedgerEntry"];
		const supportSchema = JSON.stringify(Object.fromEntries(schemaNames.map((name) => [name, schema(name)])));
		for (const forbidden of [
			'"authorization"',
			'"input"',
			'"instructions"',
			'"key"',
			'"key_hash"',
			'"messages"',
			'"output"',
			'"prompt"',
			'"tools"',
		]) {
			expect(supportSchema).not.toContain(forbidden);
		}
	});
});
