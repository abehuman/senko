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

export interface IssueApiKeyRequest {
	expiresAt: Date | null;
	name: string;
	scopes: ApiKeyScope[];
	teamId: string | null;
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
