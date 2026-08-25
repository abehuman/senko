export const OPERATIONAL_EVENT_SCHEMA_VERSION = 1;

export const OPERATIONAL_EVENT_NAMES = [
	"admission_completed",
	"admission_lease_release",
	"admission_lease_renewal",
	"api_key_last_used_update",
	"authentication_completed",
	"identity_backend_operation",
	"inference_kill_switch",
	"provider_completed",
	"provider_pool_admission",
	"provider_pool_release",
	"provider_pool_renewal",
	"provider_response_headers",
	"provider_route_selected",
	"provider_first_byte",
	"provider_first_token",
	"request_finished",
	"request_started",
	"request_trace_persistence",
	"support_lookup_completed",
	"usage_reservation_completed",
	"usage_reconciliation_completed",
	"usage_settlement_completed",
] as const;

export type OperationalEventName = (typeof OPERATIONAL_EVENT_NAMES)[number];

export type FailureCategory =
	| "admission"
	| "authentication"
	| "cancelled"
	| "configuration"
	| "internal"
	| "invalid_request"
	| "provider_protocol"
	| "provider_capacity"
	| "provider_rejected"
	| "provider_transport"
	| "quota"
	| "timeout"
	| "usage";

export interface OperationalEventInput {
	account_id?: string;
	actual_cost_microunits?: number;
	candidates?: number;
	circuit_open_until?: number;
	consecutive_failures?: number;
	duration_ms?: number;
	endpoint?:
		| "admin_account_create"
		| "admin_account_list"
		| "admin_account_reactivate"
		| "admin_account_suspend"
		| "admin_audit_event_list"
		| "admin_dependency_health"
		| "admin_api_key_issue"
		| "admin_api_key_list"
		| "admin_api_key_revoke"
		| "admin_api_key_rotate"
		| "admin_request_lookup"
		| "admin_api_key_usage_limits"
		| "admin_usage_limits"
		| "admin_team_create"
		| "admin_team_list"
		| "admin_team_archive"
		| "admin_team_reactivate"
		| "chat_completions"
		| "health"
		| "models"
		| "other"
		| "responses"
		| "root";
	event: OperationalEventName;
	failure_category?: FailureCategory;
	http_status?: number;
	input_tokens?: number;
	key_id?: string;
	method?: string;
	model?: string;
	outcome?: "allowed" | "denied" | "failed" | "started" | "succeeded";
	output_tokens?: number;
	protocol?: "openai-completions" | "openai-responses";
	provider_attempt?: number;
	provider_route?: string;
	remaining_concurrent_requests?: number;
	remaining_provider_requests?: number;
	remaining_provider_tokens?: number;
	request_id?: string;
	reserved_cost_microunits?: number;
	retry_after_seconds?: number;
	settled?: number;
	settlement_kind?: "conservative_settled" | "released" | "settled";
	skipped?: number;
	failed?: number;
	terminal_reason?: string;
	time_to_first_byte_ms?: number;
	time_to_first_token_ms?: number;
}

export interface OperationalEvent extends OperationalEventInput {
	schema_version: typeof OPERATIONAL_EVENT_SCHEMA_VERSION;
}

export interface OperationalLogger {
	emit(event: OperationalEvent): void;
}

const STRING_LIMITS = {
	account_id: 128,
	endpoint: 64,
	key_id: 128,
	method: 16,
	model: 256,
	provider_route: 64,
	request_id: 64,
	terminal_reason: 128,
} as const;

const INTEGER_FIELDS = [
	"actual_cost_microunits",
	"circuit_open_until",
	"consecutive_failures",
	"duration_ms",
	"candidates",
	"failed",
	"http_status",
	"input_tokens",
	"output_tokens",
	"provider_attempt",
	"remaining_concurrent_requests",
	"remaining_provider_requests",
	"remaining_provider_tokens",
	"reserved_cost_microunits",
	"retry_after_seconds",
	"settled",
	"skipped",
	"time_to_first_byte_ms",
	"time_to_first_token_ms",
] as const;

function safeString(value: unknown, maximumLength: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return undefined;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 || codePoint === 127) return undefined;
	}
	return value;
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function buildOperationalEvent(input: OperationalEventInput): OperationalEvent {
	const event: OperationalEvent = {
		event: input.event,
		schema_version: OPERATIONAL_EVENT_SCHEMA_VERSION,
	};
	for (const [field, maximumLength] of Object.entries(STRING_LIMITS)) {
		const value = safeString(input[field as keyof OperationalEventInput], maximumLength);
		if (value !== undefined) {
			(event as unknown as Record<string, unknown>)[field] = value;
		}
	}
	for (const field of INTEGER_FIELDS) {
		const value = safeInteger(input[field]);
		if (value !== undefined) event[field] = value;
	}
	if (input.failure_category !== undefined) event.failure_category = input.failure_category;
	if (input.outcome !== undefined) event.outcome = input.outcome;
	if (input.protocol !== undefined) event.protocol = input.protocol;
	if (input.settlement_kind !== undefined) event.settlement_kind = input.settlement_kind;
	return event;
}

export function emitOperationalEvent(logger: OperationalLogger, input: OperationalEventInput): void {
	try {
		logger.emit(buildOperationalEvent(input));
	} catch {
		// Observability must never break the request path.
	}
}

export const consoleOperationalLogger: OperationalLogger = {
	emit(event) {
		const serialized = JSON.stringify(event);
		if (event.failure_category || event.outcome === "denied" || event.outcome === "failed") {
			console.warn(serialized);
			return;
		}
		console.log(serialized);
	},
};
