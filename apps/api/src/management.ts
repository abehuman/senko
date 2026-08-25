import { API_KEY_SCOPES } from "./api-key";
import type { ApiKeyScope } from "./db/schema";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ManagementInputResult<T> =
	| { ok: true; value: T }
	| { code: string; message: string; ok: false; param: string | null };

export interface CreateAccountRequest {
	name: string;
	planKey: string;
}

export interface CreateTeamRequest {
	name: string;
}

export interface IssueApiKeyRequest {
	expiresAt: Date | null;
	name: string;
	scopes: ApiKeyScope[];
	teamId: string | null;
}

export interface ListApiKeysRequest {
	limit: number;
	startingAfter: string | null;
}

export interface ListAccountsRequest {
	limit: number;
	startingAfter: string | null;
}

export interface ListTeamsRequest {
	limit: number;
	startingAfter: string | null;
}

export interface ListAuditEventsRequest {
	limit: number;
	startingAfter: string | null;
}

export interface RotateApiKeyRequest {
	expiresAt?: Date | null;
	name?: string;
}

export interface ConfigureUsageLimitsRequest {
	currency: string;
	dailyCostMicrounits: number;
	maxRequestCostMicrounits: number;
	minuteInputTokens: number;
	minuteOutputTokens: number;
	monthlyCostMicrounits: number;
	policyVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownField(body: Record<string, unknown>, allowed: string[]): string | undefined {
	const allowedFields = new Set(allowed);
	return Object.keys(body).find((field) => !allowedFields.has(field));
}

function invalid(code: string, message: string, param: string | null): ManagementInputResult<never> {
	return { code, message, ok: false, param };
}

export function validUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

export function parseCreateAccountRequest(value: unknown): ManagementInputResult<CreateAccountRequest> {
	if (!isRecord(value)) {
		return invalid("invalid_request", "The request body must be a JSON object.", null);
	}
	const extra = unknownField(value, ["name", "plan_key"]);
	if (extra) {
		return invalid("unsupported_parameter", `The parameter "${extra}" is not supported.`, extra);
	}
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const planKey =
		value.plan_key === undefined ? "beta" : typeof value.plan_key === "string" ? value.plan_key.trim() : "";
	if (name.length === 0 || name.length > 160) {
		return invalid("invalid_name", "name must contain between 1 and 160 characters.", "name");
	}
	if (!PLAN_KEY_PATTERN.test(planKey)) {
		return invalid("invalid_plan_key", "plan_key must be a lowercase plan identifier.", "plan_key");
	}
	return { ok: true, value: { name, planKey } };
}

export function parseCreateTeamRequest(value: unknown): ManagementInputResult<CreateTeamRequest> {
	if (!isRecord(value)) {
		return invalid("invalid_request", "The request body must be a JSON object.", null);
	}
	const extra = unknownField(value, ["name"]);
	if (extra) {
		return invalid("unsupported_parameter", `The parameter "${extra}" is not supported.`, extra);
	}
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (name.length === 0 || name.length > 160) {
		return invalid("invalid_name", "name must contain between 1 and 160 characters.", "name");
	}
	return { ok: true, value: { name } };
}

export function parseIssueApiKeyRequest(value: unknown, now = new Date()): ManagementInputResult<IssueApiKeyRequest> {
	if (!isRecord(value)) {
		return invalid("invalid_request", "The request body must be a JSON object.", null);
	}
	const extra = unknownField(value, ["expires_at", "name", "scopes", "team_id"]);
	if (extra) {
		return invalid("unsupported_parameter", `The parameter "${extra}" is not supported.`, extra);
	}
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (name.length === 0 || name.length > 120) {
		return invalid("invalid_name", "name must contain between 1 and 120 characters.", "name");
	}
	if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
		return invalid("invalid_scopes", "scopes must contain at least one supported scope.", "scopes");
	}
	const scopes = [...new Set(value.scopes)];
	if (scopes.some((scope) => typeof scope !== "string" || !API_KEY_SCOPES.includes(scope as ApiKeyScope))) {
		return invalid("invalid_scopes", "scopes contains an unsupported API key scope.", "scopes");
	}
	const teamId = value.team_id === undefined || value.team_id === null ? null : value.team_id;
	if (teamId !== null && (typeof teamId !== "string" || !validUuid(teamId))) {
		return invalid("invalid_team_id", "team_id must be a UUID or null.", "team_id");
	}
	let expiresAt: Date | null = null;
	if (value.expires_at !== undefined && value.expires_at !== null) {
		if (typeof value.expires_at !== "string") {
			return invalid("invalid_expiry", "expires_at must be an ISO 8601 timestamp or null.", "expires_at");
		}
		expiresAt = new Date(value.expires_at);
		if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= now) {
			return invalid("invalid_expiry", "expires_at must be a future ISO 8601 timestamp.", "expires_at");
		}
	}
	return { ok: true, value: { expiresAt, name, scopes: scopes as ApiKeyScope[], teamId } };
}

export function parseListApiKeysRequest(
	limitValue: string | undefined,
	startingAfterValue: string | undefined,
): ManagementInputResult<ListApiKeysRequest> {
	return parseListRequest(limitValue, startingAfterValue, "API key");
}

export function parseListAccountsRequest(
	limitValue: string | undefined,
	startingAfterValue: string | undefined,
): ManagementInputResult<ListAccountsRequest> {
	return parseListRequest(limitValue, startingAfterValue, "account");
}

function parseListRequest(
	limitValue: string | undefined,
	startingAfterValue: string | undefined,
	cursorResource: string,
): ManagementInputResult<{ limit: number; startingAfter: string | null }> {
	let limit = 50;
	if (limitValue !== undefined) {
		if (!/^\d+$/.test(limitValue)) {
			return invalid("invalid_limit", "limit must be an integer between 1 and 100.", "limit");
		}
		limit = Number(limitValue);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			return invalid("invalid_limit", "limit must be an integer between 1 and 100.", "limit");
		}
	}
	const startingAfter = startingAfterValue?.trim() || null;
	if (startingAfter !== null && !validUuid(startingAfter)) {
		return invalid("invalid_starting_after", `starting_after must be a ${cursorResource} UUID.`, "starting_after");
	}
	return { ok: true, value: { limit, startingAfter } };
}

export function parseListTeamsRequest(
	limitValue: string | undefined,
	startingAfterValue: string | undefined,
): ManagementInputResult<ListTeamsRequest> {
	return parseListRequest(limitValue, startingAfterValue, "team");
}

export function parseListAuditEventsRequest(
	limitValue: string | undefined,
	startingAfterValue: string | undefined,
): ManagementInputResult<ListAuditEventsRequest> {
	return parseListRequest(limitValue, startingAfterValue, "audit event");
}

export function parseRotateApiKeyRequest(value: unknown, now = new Date()): ManagementInputResult<RotateApiKeyRequest> {
	if (!isRecord(value)) {
		return invalid("invalid_request", "The request body must be a JSON object.", null);
	}
	const extra = unknownField(value, ["expires_at", "name"]);
	if (extra) {
		return invalid("unsupported_parameter", `The parameter "${extra}" is not supported.`, extra);
	}
	let name: string | undefined;
	if (value.name !== undefined) {
		name = typeof value.name === "string" ? value.name.trim() : "";
		if (name.length === 0 || name.length > 120) {
			return invalid("invalid_name", "name must contain between 1 and 120 characters.", "name");
		}
	}
	let expiresAt: Date | null | undefined;
	if (value.expires_at === null) {
		expiresAt = null;
	} else if (value.expires_at !== undefined) {
		if (typeof value.expires_at !== "string") {
			return invalid("invalid_expiry", "expires_at must be an ISO 8601 timestamp or null.", "expires_at");
		}
		expiresAt = new Date(value.expires_at);
		if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= now) {
			return invalid("invalid_expiry", "expires_at must be a future ISO 8601 timestamp.", "expires_at");
		}
	}
	return { ok: true, value: { expiresAt, name } };
}

export function parseConfigureUsageLimitsRequest(value: unknown): ManagementInputResult<ConfigureUsageLimitsRequest> {
	if (!isRecord(value)) {
		return invalid("invalid_request", "The request body must be a JSON object.", null);
	}
	const fields = [
		"currency",
		"daily_cost_microunits",
		"max_request_cost_microunits",
		"minute_input_tokens",
		"minute_output_tokens",
		"monthly_cost_microunits",
		"policy_version",
	];
	const extra = unknownField(value, fields);
	if (extra) {
		return invalid("unsupported_parameter", `The parameter "${extra}" is not supported.`, extra);
	}
	const policyVersion = typeof value.policy_version === "string" ? value.policy_version.trim() : "";
	if (policyVersion.length === 0 || policyVersion.length > 64) {
		return invalid(
			"invalid_policy_version",
			"policy_version must contain between 1 and 64 characters.",
			"policy_version",
		);
	}
	const currency = typeof value.currency === "string" ? value.currency.trim() : "";
	if (!/^[A-Z]{3}$/.test(currency)) {
		return invalid("invalid_currency", "currency must be a three-letter uppercase code.", "currency");
	}
	const positiveInteger = (field: string): number | undefined => {
		const fieldValue = value[field];
		return typeof fieldValue === "number" && Number.isSafeInteger(fieldValue) && fieldValue > 0
			? fieldValue
			: undefined;
	};
	const minuteInputTokens = positiveInteger("minute_input_tokens");
	const minuteOutputTokens = positiveInteger("minute_output_tokens");
	const maxRequestCostMicrounits = positiveInteger("max_request_cost_microunits");
	const dailyCostMicrounits = positiveInteger("daily_cost_microunits");
	const monthlyCostMicrounits = positiveInteger("monthly_cost_microunits");
	for (const [field, fieldValue] of [
		["minute_input_tokens", minuteInputTokens],
		["minute_output_tokens", minuteOutputTokens],
		["max_request_cost_microunits", maxRequestCostMicrounits],
		["daily_cost_microunits", dailyCostMicrounits],
		["monthly_cost_microunits", monthlyCostMicrounits],
	] as const) {
		if (fieldValue === undefined) {
			return invalid("invalid_usage_limit", `${field} must be a positive safe integer.`, field);
		}
	}
	if (
		(maxRequestCostMicrounits as number) > (dailyCostMicrounits as number) ||
		(dailyCostMicrounits as number) > (monthlyCostMicrounits as number)
	) {
		return invalid(
			"invalid_usage_limit",
			"Cost limits must satisfy max_request_cost_microunits <= daily_cost_microunits <= monthly_cost_microunits.",
			"max_request_cost_microunits",
		);
	}
	return {
		ok: true,
		value: {
			currency,
			dailyCostMicrounits: dailyCostMicrounits as number,
			maxRequestCostMicrounits: maxRequestCostMicrounits as number,
			minuteInputTokens: minuteInputTokens as number,
			minuteOutputTokens: minuteOutputTokens as number,
			monthlyCostMicrounits: monthlyCostMicrounits as number,
			policyVersion,
		},
	};
}
