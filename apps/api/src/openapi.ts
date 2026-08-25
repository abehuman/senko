type JsonObject = Record<string, unknown>;

const requestIdHeader = {
	description: "Senko-generated request identifier for support and audit correlation.",
	schema: { pattern: "^req_[a-f0-9]{32}$", type: "string" },
};

const errorResponse = {
	description: "OpenAI-compatible error response.",
	content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
	headers: { "x-request-id": requestIdHeader },
};

const inferenceHeaders = {
	"x-request-id": requestIdHeader,
	"x-ratelimit-limit-concurrent-requests": { schema: { minimum: 0, type: "integer" } },
	"x-ratelimit-limit-requests": { schema: { minimum: 0, type: "integer" } },
	"x-ratelimit-remaining-concurrent-requests": { schema: { minimum: 0, type: "integer" } },
	"x-ratelimit-remaining-requests": { schema: { minimum: 0, type: "integer" } },
	"x-ratelimit-reset-requests": { schema: { type: "string" } },
};

function success(description: string, schema: JsonObject, inference = false): JsonObject {
	return {
		content: { "application/json": { schema } },
		description,
		headers: inference ? inferenceHeaders : { "x-request-id": requestIdHeader },
	};
}

function jsonBody(schemaName: string): JsonObject {
	return {
		content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
		required: true,
	};
}

function pathId(name: string, description: string): JsonObject {
	return {
		description,
		in: "path",
		name,
		required: true,
		schema: { format: "uuid", type: "string" },
	};
}

const managementErrors = {
	"400": errorResponse,
	"401": errorResponse,
	"404": errorResponse,
	"409": errorResponse,
	"413": errorResponse,
	"503": errorResponse,
};

const inferenceErrors = {
	"400": errorResponse,
	"401": errorResponse,
	"403": errorResponse,
	"409": errorResponse,
	"413": errorResponse,
	"422": errorResponse,
	"429": {
		...errorResponse,
		headers: { ...inferenceHeaders, "retry-after": { schema: { minimum: 1, type: "integer" } } },
	},
	"499": errorResponse,
	"502": errorResponse,
	"503": errorResponse,
	"504": errorResponse,
};

const inferenceSuccess = {
	content: {
		"application/json": { schema: { type: "object" } },
		"text/event-stream": { schema: { type: "string" } },
	},
	description: "Validated provider JSON or event stream.",
	headers: inferenceHeaders,
};

export const openApiDocument: JsonObject = {
	openapi: "3.1.0",
	info: {
		description:
			"Senko managed inference API. Inference routes are OpenAI-compatible where documented; management routes require a separate operator credential.",
		title: "Senko API",
		version: "0.1.0",
	},
	servers: [{ url: "/" }],
	tags: [{ name: "System" }, { name: "Inference" }, { name: "Management" }],
	paths: {
		"/": {
			get: {
				operationId: "getApiInfo",
				responses: { "200": success("API metadata.", { $ref: "#/components/schemas/ApiInfo" }) },
				security: [],
				tags: ["System"],
			},
		},
		"/health": {
			get: {
				description: "Process liveness only. This does not verify external dependencies.",
				operationId: "getLiveness",
				responses: { "200": success("Worker process is serving requests.", { $ref: "#/components/schemas/Liveness" }) },
				security: [],
				tags: ["System"],
			},
		},
		"/openapi.json": {
			get: {
				operationId: "getOpenApiDocument",
				responses: {
					"200": {
						content: { "application/json": { schema: { type: "object" } } },
						description: "OpenAPI 3.1 document.",
						headers: { "x-request-id": requestIdHeader },
					},
				},
				security: [],
				tags: ["System"],
			},
		},
		"/admin/v1/dependency-health": {
			get: {
				description: "Checks bounded configuration, database, admission, and provider-capacity dependencies.",
				operationId: "getDependencyHealth",
				responses: {
					"200": success("All required dependencies are available.", {
						$ref: "#/components/schemas/DependencyHealth",
					}),
					"401": errorResponse,
					"503": success("At least one required dependency failed.", {
						$ref: "#/components/schemas/DependencyHealth",
					}),
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/requests/{requestId}": {
			get: {
				description:
					"Returns bounded request-routing and usage-accounting metadata for support. Prompts, generated content, tool data, authorization values, and plaintext API keys are never returned.",
				operationId: "getRequestTrace",
				parameters: [
					{
						description: "Senko request ID reported to the customer.",
						in: "path",
						name: "requestId",
						required: true,
						schema: { pattern: "^req_[a-f0-9]{32}$", type: "string" },
					},
				],
				responses: {
					"200": success("Content-free request support trace.", {
						$ref: "#/components/schemas/RequestTrace",
					}),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"503": errorResponse,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts": {
			get: {
				description: "Lists bounded account metadata for the protected R0 operator boundary.",
				operationId: "listAccounts",
				parameters: [
					{
						in: "query",
						name: "limit",
						required: false,
						schema: { default: 50, maximum: 100, minimum: 1, type: "integer" },
					},
					{
						description: "Last account ID from the previous page.",
						in: "query",
						name: "starting_after",
						required: false,
						schema: { format: "uuid", type: "string" },
					},
				],
				responses: {
					"200": success("Account metadata page.", { $ref: "#/components/schemas/AccountList" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
			post: {
				operationId: "createAccount",
				requestBody: jsonBody("CreateAccountRequest"),
				responses: {
					"201": success("Account created.", { $ref: "#/components/schemas/Account" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/audit-events": {
			get: {
				description:
					"Lists bounded account-owned administrative lifecycle metadata. Request bodies, secrets, and audit metadata are excluded.",
				operationId: "listAuditEvents",
				parameters: [
					pathId("accountId", "Owning account ID."),
					{
						in: "query",
						name: "limit",
						required: false,
						schema: { default: 50, maximum: 100, minimum: 1, type: "integer" },
					},
					{
						description: "Last audit event ID from the previous page.",
						in: "query",
						name: "starting_after",
						required: false,
						schema: { format: "uuid", type: "string" },
					},
				],
				responses: {
					"200": success("Content-free audit event page.", {
						$ref: "#/components/schemas/AuditEventList",
					}),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/teams": {
			get: {
				description: "Lists bounded account-owned team metadata.",
				operationId: "listTeams",
				parameters: [
					pathId("accountId", "Owning account ID."),
					{
						in: "query",
						name: "limit",
						required: false,
						schema: { default: 50, maximum: 100, minimum: 1, type: "integer" },
					},
					{
						description: "Last team ID from the previous page.",
						in: "query",
						name: "starting_after",
						required: false,
						schema: { format: "uuid", type: "string" },
					},
				],
				responses: {
					"200": success("Team metadata page.", { $ref: "#/components/schemas/TeamList" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
			post: {
				description: "Creates an active team owned by the account.",
				operationId: "createTeam",
				parameters: [pathId("accountId", "Owning account ID.")],
				requestBody: jsonBody("CreateTeamRequest"),
				responses: {
					"201": success("Team created.", { $ref: "#/components/schemas/Team" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/teams/{teamId}/archive": {
			post: {
				description:
					"Archives the team. New authentication with team-owned API keys fails after the transaction commits.",
				operationId: "archiveTeam",
				parameters: [pathId("accountId", "Owning account ID."), pathId("teamId", "Team ID.")],
				responses: {
					"200": success("Team archived or already archived.", { $ref: "#/components/schemas/Team" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/teams/{teamId}/reactivate": {
			post: {
				description: "Reactivates an archived team only while its owning account is active.",
				operationId: "reactivateTeam",
				parameters: [pathId("accountId", "Owning account ID."), pathId("teamId", "Team ID.")],
				responses: {
					"200": success("Team active or already active.", { $ref: "#/components/schemas/Team" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/suspend": {
			post: {
				description:
					"Suspends the account. New API-key authentication fails immediately after the transaction commits.",
				operationId: "suspendAccount",
				parameters: [pathId("accountId", "Account ID.")],
				responses: {
					"200": success("Account suspended or already suspended.", { $ref: "#/components/schemas/Account" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/reactivate": {
			post: {
				description: "Reactivates a suspended account. Closed accounts cannot be reactivated.",
				operationId: "reactivateAccount",
				parameters: [pathId("accountId", "Account ID.")],
				responses: {
					"200": success("Account active or already active.", { $ref: "#/components/schemas/Account" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/api-keys": {
			get: {
				description: "Lists bounded API key metadata. Plaintext keys are never retrievable.",
				operationId: "listApiKeys",
				parameters: [
					pathId("accountId", "Owning account ID."),
					{
						in: "query",
						name: "limit",
						required: false,
						schema: { default: 50, maximum: 100, minimum: 1, type: "integer" },
					},
					{
						description: "Last API key ID from the previous page.",
						in: "query",
						name: "starting_after",
						required: false,
						schema: { format: "uuid", type: "string" },
					},
				],
				responses: {
					"200": success("API key metadata page.", { $ref: "#/components/schemas/ApiKeyList" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
			post: {
				description: "Issues a key whose plaintext value is returned exactly once.",
				operationId: "issueApiKey",
				parameters: [pathId("accountId", "Owning account ID.")],
				requestBody: jsonBody("IssueApiKeyRequest"),
				responses: {
					"201": success("API key issued.", { $ref: "#/components/schemas/IssuedApiKey" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/api-keys/{keyId}/rotate": {
			post: {
				description: "Issues a replacement key while leaving the source key active until separately revoked.",
				operationId: "rotateApiKey",
				parameters: [pathId("accountId", "Owning account ID."), pathId("keyId", "Source API key record ID.")],
				requestBody: jsonBody("RotateApiKeyRequest"),
				responses: {
					"201": success("Replacement API key issued.", { $ref: "#/components/schemas/IssuedApiKey" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/api-keys/{keyId}/revoke": {
			post: {
				operationId: "revokeApiKey",
				parameters: [pathId("accountId", "Owning account ID."), pathId("keyId", "API key record ID.")],
				responses: {
					"200": success("API key revoked.", { $ref: "#/components/schemas/ApiKey" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/api-keys/{keyId}/usage-limits": {
			put: {
				description: "Configures optional API-key limits that must not exceed the owning account limits.",
				operationId: "configureApiKeyUsageLimits",
				parameters: [pathId("accountId", "Owning account ID."), pathId("keyId", "API key record ID.")],
				requestBody: jsonBody("UsageLimitsRequest"),
				responses: {
					"200": success("API key usage limits configured.", {
						$ref: "#/components/schemas/ApiKeyUsageLimits",
					}),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/admin/v1/accounts/{accountId}/usage-limits": {
			put: {
				operationId: "configureUsageLimits",
				parameters: [pathId("accountId", "Owning account ID.")],
				requestBody: jsonBody("UsageLimitsRequest"),
				responses: {
					"200": success("Account usage limits configured.", { $ref: "#/components/schemas/UsageLimits" }),
					...managementErrors,
				},
				security: [{ SenkoAdminToken: [] }],
				tags: ["Management"],
			},
		},
		"/v1/models": {
			get: {
				operationId: "listModels",
				responses: {
					"200": success("Curated model catalog.", { $ref: "#/components/schemas/ModelList" }, true),
					"401": errorResponse,
					"403": errorResponse,
					"503": errorResponse,
				},
				security: [{ SenkoApiKey: [] }],
				tags: ["Inference"],
				"x-senko-required-scope": "models:read",
			},
		},
		"/v1/chat/completions": {
			post: {
				description: "Creates one Chat Completion. Streams terminate with data: [DONE].",
				operationId: "createChatCompletion",
				requestBody: jsonBody("ChatCompletionRequest"),
				responses: { "200": inferenceSuccess, ...inferenceErrors },
				security: [{ SenkoApiKey: [] }],
				tags: ["Inference"],
				"x-senko-required-scope": "inference:chat",
			},
		},
		"/v1/responses": {
			post: {
				description: "Creates one Responses API result. Streams emit only validated, known events.",
				operationId: "createResponse",
				requestBody: jsonBody("ResponsesRequest"),
				responses: { "200": inferenceSuccess, ...inferenceErrors },
				security: [{ SenkoApiKey: [] }],
				tags: ["Inference"],
				"x-senko-required-scope": "inference:responses",
			},
		},
	},
	components: {
		securitySchemes: {
			SenkoAdminToken: {
				bearerFormat: "Senko management token",
				description: "Separate operator credential for /admin/v1 routes.",
				scheme: "bearer",
				type: "http",
			},
			SenkoApiKey: {
				bearerFormat: "sk-senko-v1-...",
				description: "Account-owned API key with the operation's declared Senko scope.",
				scheme: "bearer",
				type: "http",
			},
		},
		schemas: {
			ApiInfo: objectSchema({ name: { const: "Senko API" }, status: { const: "ok" } }, ["name", "status"]),
			Liveness: objectSchema({ status: { const: "ok" } }, ["status"]),
			ErrorEnvelope: objectSchema({ error: { $ref: "#/components/schemas/Error" } }, ["error"]),
			Error: objectSchema(
				{
					code: { type: "string" },
					message: { type: "string" },
					param: { type: ["string", "null"] },
					type: { type: "string" },
				},
				["code", "message", "param", "type"],
			),
			DependencyHealth: objectSchema(
				{
					checks: objectSchema(
						Object.fromEntries(
							["admission", "configuration", "identity_storage", "provider_capacity", "usage_ledger"].map((name) => [
								name,
								{ enum: ["ok", "failed", "not_checked"], type: "string" },
							]),
						),
						["admission", "configuration", "identity_storage", "provider_capacity", "usage_ledger"],
					),
					object: { const: "dependency_health" },
					status: { enum: ["ok", "unhealthy"], type: "string" },
				},
				["checks", "object", "status"],
			),
			RequestLedgerEntry: objectSchema(requestLedgerEntryProperties(), Object.keys(requestLedgerEntryProperties())),
			RequestAttemptTrace: objectSchema(
				{
					account_id: { format: "uuid", type: "string" },
					api_key_id: { format: "uuid", type: "string" },
					attempt_id: { format: "uuid", type: "string" },
					created_at: { format: "date-time", type: "string" },
					currency: { pattern: "^[A-Z]{3}$", type: "string" },
					estimated_input_tokens: { minimum: 0, type: "integer" },
					ledger: { items: { $ref: "#/components/schemas/RequestLedgerEntry" }, type: "array" },
					pending_reservation: { type: "boolean" },
					policy_version: { type: "string" },
					pricing_version: { type: "string" },
					protocol: { enum: ["openai-completions", "openai-responses"], type: "string" },
					provider_attempt: { minimum: 0, type: "integer" },
					provider_route: { type: "string" },
					requested_model: { type: "string" },
					reservation_expires_at: { format: "date-time", type: "string" },
					reserved_cost_microunits: { minimum: 0, type: "integer" },
					reserved_output_tokens: { minimum: 0, type: "integer" },
					resolved_model: { type: "string" },
				},
				[
					"account_id",
					"api_key_id",
					"attempt_id",
					"created_at",
					"currency",
					"estimated_input_tokens",
					"ledger",
					"pending_reservation",
					"policy_version",
					"pricing_version",
					"protocol",
					"provider_attempt",
					"provider_route",
					"requested_model",
					"reservation_expires_at",
					"reserved_cost_microunits",
					"reserved_output_tokens",
					"resolved_model",
				],
			),
			RequestTrace: objectSchema(
				{
					account_id: { format: "uuid", type: "string" },
					api_key_id: { format: "uuid", type: "string" },
					attempts: { items: { $ref: "#/components/schemas/RequestAttemptTrace" }, maxItems: 16, type: "array" },
					completed_at: { format: "date-time", type: "string" },
					endpoint: { enum: ["models", "chat_completions", "responses"], type: "string" },
					failure_category: {
						enum: [
							"admission",
							"authentication",
							"cancelled",
							"configuration",
							"internal",
							"invalid_request",
							"provider_protocol",
							"provider_capacity",
							"provider_rejected",
							"provider_transport",
							"quota",
							"timeout",
							"usage",
							null,
						],
					},
					has_more: { type: "boolean" },
					http_status: { maximum: 599, minimum: 100, type: "integer" },
					method: { enum: ["GET", "POST"], type: "string" },
					object: { const: "request_trace" },
					request_id: { pattern: "^req_[a-f0-9]{32}$", type: "string" },
					started_at: { format: "date-time", type: "string" },
				},
				[
					"account_id",
					"api_key_id",
					"attempts",
					"completed_at",
					"endpoint",
					"failure_category",
					"has_more",
					"http_status",
					"method",
					"object",
					"request_id",
					"started_at",
				],
			),
			CreateAccountRequest: objectSchema(
				{
					name: { maxLength: 160, minLength: 1, type: "string" },
					plan_key: { default: "beta", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", type: "string" },
				},
				["name"],
			),
			Account: objectSchema(
				{
					created_at: { format: "date-time", type: "string" },
					id: { format: "uuid", type: "string" },
					name: { type: "string" },
					object: { const: "account" },
					plan_key: { type: "string" },
					status: { enum: ["active", "suspended", "closed"], type: "string" },
					suspended_at: { format: "date-time", type: ["string", "null"] },
				},
				["created_at", "id", "name", "object", "plan_key", "status", "suspended_at"],
			),
			AccountList: objectSchema(
				{
					data: { items: { $ref: "#/components/schemas/Account" }, type: "array" },
					has_more: { type: "boolean" },
					next_starting_after: { format: "uuid", type: ["string", "null"] },
					object: { const: "list" },
				},
				["data", "has_more", "next_starting_after", "object"],
			),
			AuditEvent: objectSchema(
				{
					account_id: { format: "uuid", type: "string" },
					action: { maxLength: 80, type: "string" },
					actor_type: { enum: ["api_key", "system", "user"], type: "string" },
					created_at: { format: "date-time", type: "string" },
					id: { format: "uuid", type: "string" },
					object: { const: "audit_event" },
					request_id: { maxLength: 64, type: ["string", "null"] },
					target_id: { maxLength: 128, type: ["string", "null"] },
					target_type: { maxLength: 64, type: "string" },
				},
				["account_id", "action", "actor_type", "created_at", "id", "object", "request_id", "target_id", "target_type"],
			),
			AuditEventList: objectSchema(
				{
					data: { items: { $ref: "#/components/schemas/AuditEvent" }, type: "array" },
					has_more: { type: "boolean" },
					next_starting_after: { format: "uuid", type: ["string", "null"] },
					object: { const: "list" },
				},
				["data", "has_more", "next_starting_after", "object"],
			),
			CreateTeamRequest: objectSchema(
				{
					name: { maxLength: 160, minLength: 1, type: "string" },
				},
				["name"],
			),
			Team: objectSchema(
				{
					account_id: { format: "uuid", type: "string" },
					created_at: { format: "date-time", type: "string" },
					id: { format: "uuid", type: "string" },
					name: { type: "string" },
					object: { const: "team" },
					status: { enum: ["active", "archived"], type: "string" },
				},
				["account_id", "created_at", "id", "name", "object", "status"],
			),
			TeamList: objectSchema(
				{
					data: { items: { $ref: "#/components/schemas/Team" }, type: "array" },
					has_more: { type: "boolean" },
					next_starting_after: { format: "uuid", type: ["string", "null"] },
					object: { const: "list" },
				},
				["data", "has_more", "next_starting_after", "object"],
			),
			IssueApiKeyRequest: objectSchema(
				{
					expires_at: { format: "date-time", type: ["string", "null"] },
					name: { maxLength: 120, minLength: 1, type: "string" },
					scopes: {
						items: { enum: ["models:read", "inference:chat", "inference:responses"], type: "string" },
						minItems: 1,
						type: "array",
						uniqueItems: true,
					},
					team_id: { format: "uuid", type: ["string", "null"] },
				},
				["name", "scopes"],
			),
			RotateApiKeyRequest: objectSchema(
				{
					expires_at: { format: "date-time", type: ["string", "null"] },
					name: { maxLength: 120, minLength: 1, type: "string" },
				},
				[],
			),
			ApiKey: objectSchema(apiKeyProperties(), Object.keys(apiKeyProperties())),
			ApiKeyList: objectSchema(
				{
					data: { items: { $ref: "#/components/schemas/ApiKey" }, type: "array" },
					has_more: { type: "boolean" },
					next_starting_after: { format: "uuid", type: ["string", "null"] },
					object: { const: "list" },
				},
				["data", "has_more", "next_starting_after", "object"],
			),
			IssuedApiKey: objectSchema({ ...apiKeyProperties(), key: { type: "string" }, warning: { type: "string" } }, [
				...Object.keys(apiKeyProperties()),
				"key",
				"warning",
			]),
			UsageLimitsRequest: objectSchema(usageLimitProperties(), Object.keys(usageLimitProperties())),
			UsageLimits: objectSchema(
				{
					...usageLimitProperties(),
					account_id: { format: "uuid", type: "string" },
					object: { const: "account_usage_limits" },
				},
				[...Object.keys(usageLimitProperties()), "account_id", "object"],
			),
			ApiKeyUsageLimits: objectSchema(
				{
					...usageLimitProperties(),
					account_id: { format: "uuid", type: "string" },
					api_key_id: { format: "uuid", type: "string" },
					object: { const: "api_key_usage_limits" },
				},
				[...Object.keys(usageLimitProperties()), "account_id", "api_key_id", "object"],
			),
			Model: objectSchema(modelProperties(), Object.keys(modelProperties())),
			ModelList: objectSchema(
				{ data: { items: { $ref: "#/components/schemas/Model" }, type: "array" }, object: { const: "list" } },
				["data", "object"],
			),
			FunctionTool: {
				additionalProperties: true,
				properties: { type: { const: "function" } },
				required: ["type"],
				type: "object",
			},
			ChatCompletionRequest: objectSchema(chatRequestProperties(), ["messages", "model"]),
			ResponsesRequest: objectSchema(responsesRequestProperties(), ["input", "model"]),
		},
	},
};

function objectSchema(properties: JsonObject, required: string[]): JsonObject {
	return { additionalProperties: false, properties, required, type: "object" };
}

function apiKeyProperties(): JsonObject {
	return {
		account_id: { format: "uuid", type: "string" },
		created_at: { format: "date-time", type: "string" },
		expires_at: { format: "date-time", type: ["string", "null"] },
		id: { format: "uuid", type: "string" },
		key_prefix: { type: "string" },
		last_used_at: { format: "date-time", type: ["string", "null"] },
		name: { type: "string" },
		object: { const: "api_key" },
		public_id: { type: "string" },
		replaces_api_key_id: { format: "uuid", type: ["string", "null"] },
		revoked_at: { format: "date-time", type: ["string", "null"] },
		rotation_group_id: { format: "uuid", type: "string" },
		scopes: { items: { type: "string" }, type: "array" },
		status: { type: "string" },
		team_id: { format: "uuid", type: ["string", "null"] },
	};
}

function usageLimitProperties(): JsonObject {
	return {
		currency: { pattern: "^[A-Z]{3}$", type: "string" },
		daily_cost_microunits: { minimum: 1, type: "integer" },
		max_request_cost_microunits: { minimum: 1, type: "integer" },
		minute_input_tokens: { minimum: 1, type: "integer" },
		minute_output_tokens: { minimum: 1, type: "integer" },
		monthly_cost_microunits: { minimum: 1, type: "integer" },
		policy_version: { maxLength: 64, minLength: 1, type: "string" },
	};
}

function requestLedgerEntryProperties(): JsonObject {
	return {
		created_at: { format: "date-time", type: "string" },
		event_type: { type: "string" },
		phase: { type: "string" },
		released_cost_microunits: { minimum: 0, type: "integer" },
		released_input_tokens: { minimum: 0, type: "integer" },
		released_output_tokens: { minimum: 0, type: "integer" },
		reserved_cost_microunits: { minimum: 0, type: "integer" },
		reserved_input_tokens: { minimum: 0, type: "integer" },
		reserved_output_tokens: { minimum: 0, type: "integer" },
		settled_cost_microunits: { minimum: 0, type: "integer" },
		settled_input_tokens: { minimum: 0, type: "integer" },
		settled_output_tokens: { minimum: 0, type: "integer" },
		terminal_reason: { type: ["string", "null"] },
		usage_source: { type: "string" },
	};
}

function modelProperties(): JsonObject {
	return {
		context_window: { minimum: 1, type: "integer" },
		created: { minimum: 0, type: "integer" },
		id: { type: "string" },
		input_modalities: { items: { enum: ["text", "image", "audio"], type: "string" }, type: "array" },
		max_output_tokens: { minimum: 1, type: "integer" },
		object: { const: "model" },
		owned_by: { type: "string" },
		reasoning: { type: "boolean" },
		supported_protocols: {
			items: { enum: ["openai-completions", "openai-responses"], type: "string" },
			type: "array",
		},
	};
}

function chatRequestProperties(): JsonObject {
	return {
		frequency_penalty: { type: "number" },
		max_completion_tokens: { maximum: 16384, minimum: 1, type: "integer" },
		max_tokens: { maximum: 16384, minimum: 1, type: "integer" },
		messages: { items: { type: "object" }, type: "array" },
		model: { type: "string" },
		n: { const: 1 },
		parallel_tool_calls: { type: "boolean" },
		presence_penalty: { type: "number" },
		prompt_cache_key: { type: "string" },
		reasoning_effort: { type: "string" },
		response_format: { type: "object" },
		seed: { type: "integer" },
		stop: { oneOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }] },
		store: { const: false, default: false },
		stream: { type: "boolean" },
		stream_options: {
			additionalProperties: false,
			properties: { include_usage: { type: "boolean" } },
			type: "object",
		},
		temperature: { type: "number" },
		tool_choice: { oneOf: [{ type: "string" }, { type: "object" }] },
		tools: { items: { $ref: "#/components/schemas/FunctionTool" }, type: "array" },
		top_p: { type: "number" },
		verbosity: { type: "string" },
	};
}

function responsesRequestProperties(): JsonObject {
	return {
		background: { const: false, default: false },
		include: { items: { const: "reasoning.encrypted_content" }, type: "array" },
		input: { oneOf: [{ type: "string" }, { items: {}, type: "array" }] },
		instructions: { type: "string" },
		max_output_tokens: { maximum: 16384, minimum: 1, type: "integer" },
		model: { type: "string" },
		parallel_tool_calls: { type: "boolean" },
		prompt_cache_key: { type: "string" },
		reasoning: { type: "object" },
		store: { const: false, default: false },
		stream: { type: "boolean" },
		temperature: { type: "number" },
		text: { type: "object" },
		tool_choice: { oneOf: [{ type: "string" }, { type: "object" }] },
		tools: { items: { $ref: "#/components/schemas/FunctionTool" }, type: "array" },
		top_p: { type: "number" },
		truncation: { type: "string" },
	};
}
