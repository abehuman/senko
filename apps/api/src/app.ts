import { type Context, Hono } from "hono";
import { type AdmissionClient, type AdmissionRenewalResult, durableObjectAdmissionClient } from "./admission";
import {
	type AdmissionRateLimit,
	LEASE_RENEW_INTERVAL_MS,
	LEASE_RENEW_RETRY_INTERVAL_MS,
	LEASE_RENEW_SAFETY_MARGIN_MS,
} from "./admission-state";
import { authenticate, authenticateSecret } from "./auth";
import { readBoundedJson } from "./body";
import { getAuthenticationMode, getInferenceEnabled, getModelCatalog } from "./config";
import type { ApiKeyScope } from "./db/schema";
import { type DependencyHealthService, dependencyHealthService } from "./dependency-health";
import { apiError, applyRateLimitHeaders, responseHeaders } from "./http";
import {
	type AccountRecord,
	type ApiKeyRecord,
	type AuditEventRecord,
	type IdentityResult,
	type IdentityService,
	postgresIdentityService,
	type TeamRecord,
} from "./identity";
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
} from "./management";
import {
	consoleOperationalLogger,
	emitOperationalEvent,
	type FailureCategory,
	type OperationalEventInput,
	type OperationalLogger,
} from "./observability";
import { openApiDocument } from "./openapi";
import {
	normalizedProviderSseBody,
	normalizeProviderJson,
	ProviderResponseValidationError,
	ProviderSseNormalizer,
} from "./provider-adapter";
import {
	durableObjectProviderPoolClient,
	type ProviderPoolClient,
	type ProviderPoolRenewalResult,
} from "./provider-pool";
import {
	PROVIDER_POOL_RENEW_INTERVAL_MS,
	PROVIDER_POOL_RENEW_RETRY_INTERVAL_MS,
	PROVIDER_POOL_RENEW_SAFETY_MARGIN_MS,
	type ProviderPoolReleaseOutcome,
} from "./provider-pool-state";
import { getProviderRouteCandidates } from "./provider-routing";
import {
	boundedProviderBody,
	createProviderRequestControl,
	DEFAULT_PROVIDER_REQUEST_LIMITS,
	type ProviderAbortReason,
	type ProviderRequestControl,
	type ProviderRequestLimits,
	readBoundedProviderJson,
} from "./provider-stream";
import { ProviderUsageObserver } from "./provider-usage";
import { normalizeLlmApiRequest } from "./request-policy";
import {
	type PersistedRequestTraceEndpoint,
	postgresSupportService,
	type SupportResult,
	type SupportService,
	validRequestId,
} from "./support";
import type { ApiProtocol, AppEnv, LlmApiFetch, ModelDefinition, ProviderRoute } from "./types";
import {
	estimateInputTokens,
	type FinalizeUsageInput,
	type ProviderUsage,
	postgresUsageService,
	type UsageReservation,
	type UsageResult,
	type UsageService,
} from "./usage";

interface CreateAppOptions {
	admissionClient?: AdmissionClient;
	dependencyHealthService?: DependencyHealthService;
	identityService?: IdentityService;
	llmApiFetch?: LlmApiFetch;
	operationalLogger?: OperationalLogger;
	providerPoolClient?: ProviderPoolClient;
	providerRequestLimits?: Partial<ProviderRequestLimits>;
	supportService?: SupportService;
	usageService?: UsageService;
}

export const MAX_OUTPUT_TOKENS_PER_REQUEST = 16_384;

const REQUIRED_SCOPES = new Map<string, ApiKeyScope>([
	["GET /v1/models", "models:read"],
	["POST /v1/chat/completions", "inference:chat"],
	["POST /v1/responses", "inference:responses"],
]);

function requestId(): string {
	return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

function endpointFor(method: string, path: string): OperationalEventInput["endpoint"] {
	if (method === "GET" && path === "/") return "root";
	if (method === "GET" && path === "/health") return "health";
	if (method === "GET" && path === "/admin/v1/dependency-health") return "admin_dependency_health";
	if (method === "GET" && /^\/admin\/v1\/requests\/[^/]+$/.test(path)) return "admin_request_lookup";
	if (method === "GET" && path === "/v1/models") return "models";
	if (method === "POST" && path === "/v1/chat/completions") return "chat_completions";
	if (method === "POST" && path === "/v1/responses") return "responses";
	if (method === "POST" && path === "/admin/v1/accounts") return "admin_account_create";
	if (method === "GET" && path === "/admin/v1/accounts") return "admin_account_list";
	if (method === "GET" && /^\/admin\/v1\/accounts\/[^/]+\/audit-events$/.test(path)) {
		return "admin_audit_event_list";
	}
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/teams$/.test(path)) return "admin_team_create";
	if (method === "GET" && /^\/admin\/v1\/accounts\/[^/]+\/teams$/.test(path)) return "admin_team_list";
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/teams\/[^/]+\/archive$/.test(path)) {
		return "admin_team_archive";
	}
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/teams\/[^/]+\/reactivate$/.test(path)) {
		return "admin_team_reactivate";
	}
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/suspend$/.test(path)) return "admin_account_suspend";
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/reactivate$/.test(path)) {
		return "admin_account_reactivate";
	}
	if (method === "PUT" && /^\/admin\/v1\/accounts\/[^/]+\/usage-limits$/.test(path)) {
		return "admin_usage_limits";
	}
	if (method === "PUT" && /^\/admin\/v1\/accounts\/[^/]+\/api-keys\/[^/]+\/usage-limits$/.test(path)) {
		return "admin_api_key_usage_limits";
	}
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/api-keys$/.test(path)) {
		return "admin_api_key_issue";
	}
	if (method === "GET" && /^\/admin\/v1\/accounts\/[^/]+\/api-keys$/.test(path)) {
		return "admin_api_key_list";
	}
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/api-keys\/[^/]+\/rotate$/.test(path)) {
		return "admin_api_key_rotate";
	}
	if (method === "POST" && /^\/admin\/v1\/accounts\/[^/]+\/api-keys\/[^/]+\/revoke$/.test(path)) {
		return "admin_api_key_revoke";
	}
	return "other";
}

function requestTraceEndpoint(endpoint: OperationalEventInput["endpoint"]): PersistedRequestTraceEndpoint | undefined {
	// Model discovery is frequently polled. Keep it out of request_traces so its write rate and retention are both zero.
	return endpoint === "chat_completions" || endpoint === "responses" ? endpoint : undefined;
}

function failureCategoryForStatus(status: number): FailureCategory | undefined {
	if (status < 400) return undefined;
	if (status === 401 || status === 403) return "authentication";
	if (status === 408 || status === 499 || status === 504) return status === 499 ? "cancelled" : "timeout";
	if (status === 429) return "quota";
	if (status >= 500) return "internal";
	return "invalid_request";
}

function providerFailureCategory(reason: string | undefined): FailureCategory {
	if (reason === "client_aborted") return "cancelled";
	if (reason?.includes("timeout")) return "timeout";
	if (reason === "admission_lost") return "admission";
	if (reason === "provider_pool_lost") return "provider_capacity";
	if (reason?.startsWith("provider_terminal_")) return "provider_rejected";
	if (
		reason?.includes("invalid") ||
		reason?.includes("incompatible") ||
		reason?.includes("missing") ||
		reason?.includes("too_large")
	) {
		return "provider_protocol";
	}
	if (reason?.includes("rejected")) return "provider_rejected";
	return "provider_transport";
}

const PROVIDER_ROUTE_FAILURE_ERROR_CODES = new Set([
	"authentication_error",
	"insufficient_quota",
	"internal_error",
	"internal_server_error",
	"invalid_api_key",
	"overloaded",
	"overloaded_error",
	"rate_limit_exceeded",
	"server_error",
	"service_unavailable",
	"temporarily_unavailable",
	"upstream_error",
]);

function providerPoolReleaseOutcome(
	outcome: "failed" | "succeeded",
	terminalReason: string,
	status?: number,
	terminalErrorCode?: string,
): ProviderPoolReleaseOutcome {
	if (outcome === "succeeded") return "succeeded";
	if (
		terminalReason === "client_aborted" ||
		terminalReason === "admission_lost" ||
		terminalReason === "provider_pool_lost"
	) {
		return "neutral";
	}
	if (terminalReason.startsWith("provider_terminal_")) {
		if (terminalReason === "provider_terminal_response_incomplete") return "neutral";
		return terminalErrorCode && PROVIDER_ROUTE_FAILURE_ERROR_CODES.has(terminalErrorCode.toLowerCase())
			? "route_failure"
			: "neutral";
	}
	if (
		terminalReason.includes("rejected") &&
		status !== 402 &&
		status !== 401 &&
		status !== 403 &&
		status !== 429 &&
		(status === undefined || status < 500)
	) {
		return "neutral";
	}
	return "route_failure";
}

function modelResponse(model: ModelDefinition, alias?: string): Record<string, unknown> {
	return {
		context_window: model.context_window,
		created: model.created,
		id: alias ?? model.id,
		input_modalities: model.input_modalities,
		max_output_tokens: model.max_output_tokens,
		object: "model",
		owned_by: model.owned_by,
		reasoning: model.reasoning,
		resolved_model: model.id,
		supported_protocols: model.supported_protocols,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathForProtocol(protocol: ApiProtocol): string {
	return protocol === "openai-completions" ? "/chat/completions" : "/responses";
}

type OutputTokenParam = "max_completion_tokens" | "max_output_tokens" | "max_tokens";

function outputTokenParam(body: Record<string, unknown>, protocol: ApiProtocol): OutputTokenParam | undefined {
	if (protocol === "openai-responses") {
		return "max_output_tokens";
	}
	if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) {
		return undefined;
	}
	return body.max_tokens !== undefined ? "max_tokens" : "max_completion_tokens";
}

function llmApiRequestHeaders(apiKey: string, id: string, stream: boolean): Headers {
	return new Headers({
		accept: stream ? "text/event-stream" : "application/json",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
		"x-request-id": id,
	});
}

function withRateLimit(response: Response, rateLimit: AdmissionRateLimit): Response {
	applyRateLimitHeaders(response.headers, rateLimit);
	return response;
}

function identityFailureResponse<T>(
	result: Extract<IdentityResult<T>, { ok: false }>,
	logger: OperationalLogger,
	requestId: string,
): Response {
	emitOperationalEvent(logger, {
		event: "identity_backend_operation",
		failure_category: result.reason === "configuration_error" ? "configuration" : "internal",
		outcome: "failed",
		request_id: requestId,
		terminal_reason: result.reason,
	});
	if (result.reason === "configuration_error") {
		return apiError({
			code: "configuration_error",
			message: result.message ?? "Configure the identity database before using this endpoint.",
			requestId,
			status: 503,
			type: "server_error",
		});
	}
	if (result.reason === "unavailable") {
		return apiError({
			code: "identity_unavailable",
			message: "Identity storage is temporarily unavailable.",
			requestId,
			status: 503,
			type: "server_error",
		});
	}
	return apiError({
		code: result.reason === "conflict" ? "identity_conflict" : "not_found",
		message:
			result.reason === "conflict"
				? "The account, team, or API key is not active."
				: "The requested account, team, or API key does not exist.",
		requestId,
		status: result.reason === "conflict" ? 409 : 404,
		type: "invalid_request_error",
	});
}

function usageManagementFailureResponse<T>(
	result: Extract<UsageResult<T>, { ok: false }>,
	logger: OperationalLogger,
	requestId: string,
): Response {
	emitOperationalEvent(logger, {
		event: "usage_reservation_completed",
		failure_category: result.reason === "configuration_error" ? "configuration" : "usage",
		outcome: "failed",
		request_id: requestId,
		terminal_reason: result.reason,
	});
	if (result.reason === "configuration_error") {
		return apiError({
			code: "configuration_error",
			message: result.message ?? "Configure the usage database before using this endpoint.",
			requestId,
			status: 503,
			type: "server_error",
		});
	}
	if (result.reason === "unavailable") {
		return apiError({
			code: "usage_unavailable",
			message: "Usage storage is temporarily unavailable.",
			requestId,
			status: 503,
			type: "server_error",
		});
	}
	return apiError({
		code: result.reason === "conflict" ? "account_not_active" : "not_found",
		message:
			result.message ??
			(result.reason === "conflict" ? "The account is not active." : "The requested account does not exist."),
		requestId,
		status: result.reason === "conflict" ? 409 : 404,
		type: "invalid_request_error",
	});
}

function supportFailureResponse<T>(
	result: Extract<SupportResult<T>, { ok: false }>,
	logger: OperationalLogger,
	requestId: string,
): Response {
	emitOperationalEvent(logger, {
		event: "support_lookup_completed",
		failure_category: result.reason === "configuration_error" ? "configuration" : "internal",
		outcome: "failed",
		request_id: requestId,
		terminal_reason: result.reason,
	});
	if (result.reason === "not_found") {
		return apiError({
			code: "request_not_found",
			message: "The requested Senko request ID does not exist.",
			requestId,
			status: 404,
			type: "invalid_request_error",
		});
	}
	return apiError({
		code: result.reason === "configuration_error" ? "configuration_error" : "support_lookup_unavailable",
		message:
			result.reason === "configuration_error"
				? (result.message ?? "Configure the usage database before using support lookup.")
				: "Support lookup is temporarily unavailable.",
		requestId,
		status: 503,
		type: "server_error",
	});
}

function usageAdmissionFailureResponse<T>(
	result: Extract<UsageResult<T>, { ok: false }>,
	requestId: string,
	rateLimit: AdmissionRateLimit,
): Response {
	if (result.reason === "limit_exceeded") {
		const response = apiError({
			code: "usage_limit_exceeded",
			message: "The account usage limit has been reached. Retry after the applicable usage window resets.",
			param: result.dimension ?? null,
			requestId,
			status: 429,
			type: "rate_limit_error",
		});
		response.headers.set("retry-after", "60");
		return withRateLimit(response, rateLimit);
	}
	if (result.reason === "unconfigured") {
		return withRateLimit(
			apiError({
				code: "usage_limits_unconfigured",
				message: "Configure account usage limits before serving database-authenticated inference requests.",
				requestId,
				status: 503,
				type: "server_error",
			}),
			rateLimit,
		);
	}
	if (result.reason === "configuration_error") {
		return withRateLimit(
			apiError({
				code: "configuration_error",
				message: result.message ?? "Configure usage accounting before serving inference requests.",
				requestId,
				status: 503,
				type: "server_error",
			}),
			rateLimit,
		);
	}
	return withRateLimit(
		apiError({
			code: result.reason === "conflict" ? "usage_conflict" : "usage_unavailable",
			message:
				result.reason === "conflict"
					? "The inference usage reservation conflicts with an existing request."
					: "Usage accounting is temporarily unavailable.",
			requestId,
			status: result.reason === "conflict" ? 409 : 503,
			type: "server_error",
		}),
		rateLimit,
	);
}

function scheduleUsageFinalization(
	c: Context<AppEnv>,
	usageService: UsageService,
	input: FinalizeUsageInput,
	logger: OperationalLogger,
	requestId: string,
): void {
	const operation = usageService
		.finalize(c.env, input)
		.then((result) => {
			if (!result.ok) {
				emitOperationalEvent(logger, {
					account_id: input.accountId,
					event: "usage_settlement_completed",
					failure_category: "usage",
					outcome: "failed",
					request_id: requestId,
					settlement_kind: input.kind,
					terminal_reason: result.reason,
				});
			} else {
				emitOperationalEvent(logger, {
					account_id: input.accountId,
					actual_cost_microunits: result.value.settledCostMicrounits,
					event: "usage_settlement_completed",
					failure_category: result.value.overLimitAfterSettlement ? "quota" : undefined,
					input_tokens: input.kind === "settled" ? input.usage.inputTokens : undefined,
					outcome: result.value.overLimitAfterSettlement ? "failed" : "succeeded",
					output_tokens: input.kind === "settled" ? input.usage.outputTokens : undefined,
					request_id: requestId,
					settlement_kind: input.kind,
					terminal_reason: input.terminalReason,
				});
			}
		})
		.catch(() => {
			emitOperationalEvent(logger, {
				account_id: input.accountId,
				event: "usage_settlement_completed",
				failure_category: "usage",
				outcome: "failed",
				request_id: requestId,
				settlement_kind: input.kind,
				terminal_reason: "exception",
			});
		});
	try {
		c.executionCtx.waitUntil(operation);
	} catch {
		void operation;
	}
}

function apiKeyResponse(key: ApiKeyRecord): Record<string, unknown> {
	return {
		account_id: key.accountId,
		created_at: key.createdAt,
		expires_at: key.expiresAt,
		id: key.id,
		key_prefix: key.keyPrefix,
		last_used_at: key.lastUsedAt,
		name: key.name,
		object: "api_key",
		public_id: key.publicId,
		replaces_api_key_id: key.replacesApiKeyId,
		revoked_at: key.revokedAt,
		rotation_group_id: key.rotationGroupId,
		scopes: key.scopes,
		status: key.status,
		team_id: key.teamId,
	};
}

function accountResponse(account: AccountRecord): Record<string, unknown> {
	return {
		created_at: account.createdAt,
		id: account.id,
		name: account.name,
		object: "account",
		plan_key: account.planKey,
		status: account.status,
		suspended_at: account.suspendedAt,
	};
}

function teamResponse(team: TeamRecord): Record<string, unknown> {
	return {
		account_id: team.accountId,
		created_at: team.createdAt,
		id: team.id,
		name: team.name,
		object: "team",
		status: team.status,
	};
}

function auditEventResponse(event: AuditEventRecord): Record<string, unknown> {
	return {
		account_id: event.accountId,
		action: event.action,
		actor_type: event.actorType,
		created_at: event.createdAt,
		id: event.id,
		object: "audit_event",
		request_id: event.requestId,
		target_id: event.targetId,
		target_type: event.targetType,
	};
}

function noStoreHeaders(): Record<string, string> {
	return { "cache-control": "no-store", pragma: "no-cache" };
}

function safeProviderField(value: unknown, fallback: string, maximumLength = 128): string {
	return typeof value === "string" && value.length > 0 && value.length <= maximumLength && /^[\w.-]+$/.test(value)
		? value
		: fallback;
}

function safeProviderMessage(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	let sanitized = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		const isUnsafeControl =
			codePoint <= 8 ||
			codePoint === 11 ||
			codePoint === 12 ||
			(codePoint >= 14 && codePoint <= 31) ||
			codePoint === 127;
		sanitized += isUnsafeControl ? " " : character;
		if (sanitized.length >= 2_048) break;
	}
	return sanitized.slice(0, 2_048);
}

function safeProviderParam(value: unknown): string | null {
	return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9_.[\]-]+$/.test(value) ? value : null;
}

function compatibleLlmApiError(options: {
	body: unknown;
	headers: Headers;
	id: string;
	rateLimit: AdmissionRateLimit;
	status: number;
}): Response {
	const safeClientError = [400, 408, 409, 413, 422, 429].includes(options.status);
	const providerError = isRecord(options.body) && isRecord(options.body.error) ? options.body.error : undefined;
	const providerMessage = safeProviderMessage(providerError?.message);
	const response = apiError({
		code: safeClientError ? safeProviderField(providerError?.code, "llm_api_error") : "llm_api_error",
		message: safeClientError && providerMessage ? providerMessage : "The configured LLM API rejected the request.",
		param: safeClientError ? safeProviderParam(providerError?.param) : null,
		requestId: options.id,
		status: safeClientError ? options.status : 502,
		type: safeClientError ? safeProviderField(providerError?.type, "llm_api_error") : "llm_api_error",
	});
	const retryAfter = options.headers.get("retry-after");
	if (retryAfter) {
		response.headers.set("retry-after", retryAfter);
	}
	return withRateLimit(response, options.rateLimit);
}

function logAdmissionFailure(
	logger: OperationalLogger,
	event: "admission_lease_release" | "admission_lease_renewal",
	requestId: string,
): void {
	emitOperationalEvent(logger, {
		event,
		failure_category: "admission",
		outcome: "failed",
		request_id: requestId,
	});
}

function startAdmissionHeartbeat(options: {
	admissionClient: AdmissionClient;
	env: AppEnv["Bindings"];
	leaseExpiresAt: number;
	leaseId: string;
	logger: OperationalLogger;
	onLost: () => void;
	requestId: string;
}): { stop(): void } {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let leaseExpiresAt = options.leaseExpiresAt;
	const loseLease = (): void => {
		stopped = true;
		logAdmissionFailure(options.logger, "admission_lease_renewal", options.requestId);
		options.onLost();
	};
	const schedule = (delayMs = LEASE_RENEW_INTERVAL_MS): void => {
		timer = setTimeout(() => {
			void (async () => {
				let renewal: AdmissionRenewalResult;
				try {
					renewal = await options.admissionClient.renew(options.env, options.leaseId);
				} catch {
					renewal = { ok: false, reason: "unavailable" };
				}
				if (stopped) {
					return;
				}
				if (renewal.ok) {
					leaseExpiresAt = renewal.leaseExpiresAt;
					schedule();
					return;
				}
				if (renewal.reason === "missing") {
					loseLease();
					return;
				}
				const retryDeadline = leaseExpiresAt - LEASE_RENEW_SAFETY_MARGIN_MS;
				const remainingRetryTime = retryDeadline - Date.now();
				if (remainingRetryTime <= 0) {
					loseLease();
					return;
				}
				schedule(Math.min(LEASE_RENEW_RETRY_INTERVAL_MS, remainingRetryTime));
			})();
		}, delayMs);
	};
	schedule();
	return {
		stop() {
			stopped = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		},
	};
}

function startProviderPoolHeartbeat(options: {
	env: AppEnv["Bindings"];
	leaseExpiresAt: number;
	leaseId: string;
	logger: OperationalLogger;
	onLost: () => void;
	providerPoolClient: ProviderPoolClient;
	requestId: string;
	routeId: string;
}): { stop(): void } {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let leaseExpiresAt = options.leaseExpiresAt;
	const loseLease = (): void => {
		stopped = true;
		emitOperationalEvent(options.logger, {
			event: "provider_pool_renewal",
			failure_category: "provider_capacity",
			outcome: "failed",
			provider_route: options.routeId,
			request_id: options.requestId,
		});
		options.onLost();
	};
	const schedule = (delayMs = PROVIDER_POOL_RENEW_INTERVAL_MS): void => {
		timer = setTimeout(() => {
			void (async () => {
				let renewal: ProviderPoolRenewalResult;
				try {
					renewal = await options.providerPoolClient.renew(options.env, options.routeId, options.leaseId);
				} catch {
					renewal = { ok: false, reason: "unavailable" };
				}
				if (stopped) return;
				if (renewal.ok) {
					leaseExpiresAt = renewal.leaseExpiresAt;
					schedule();
					return;
				}
				if (renewal.reason === "missing") {
					loseLease();
					return;
				}
				const remainingRetryTime = leaseExpiresAt - PROVIDER_POOL_RENEW_SAFETY_MARGIN_MS - Date.now();
				if (remainingRetryTime <= 0) {
					loseLease();
					return;
				}
				schedule(Math.min(PROVIDER_POOL_RENEW_RETRY_INTERVAL_MS, remainingRetryTime));
			})();
		}, delayMs);
	};
	schedule();
	return {
		stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

function providerFailureResponse(
	reason: ProviderAbortReason | undefined,
	id: string,
	rateLimit: AdmissionRateLimit,
): Response {
	if (reason === "admission_lost") {
		return withRateLimit(
			apiError({
				code: "admission_unavailable",
				message: "Inference admission control became unavailable.",
				requestId: id,
				status: 503,
				type: "server_error",
			}),
			rateLimit,
		);
	}
	if (reason === "provider_pool_lost") {
		return withRateLimit(
			apiError({
				code: "provider_capacity_unavailable",
				message: "The selected provider capacity lease became unavailable.",
				requestId: id,
				status: 503,
				type: "server_error",
			}),
			rateLimit,
		);
	}
	if (reason === "client_aborted") {
		return withRateLimit(
			apiError({
				code: "request_cancelled",
				message: "The client cancelled the request.",
				requestId: id,
				status: 499,
				type: "invalid_request_error",
			}),
			rateLimit,
		);
	}
	if (reason === "first_byte_timeout" || reason === "stream_idle_timeout" || reason === "total_timeout") {
		return withRateLimit(
			apiError({
				code: "llm_api_timeout",
				message: "The configured LLM API did not respond before the Senko deadline.",
				requestId: id,
				status: 504,
				type: "llm_api_error",
			}),
			rateLimit,
		);
	}
	return withRateLimit(
		apiError({
			code: "llm_api_unavailable",
			message: "The configured LLM API is temporarily unavailable.",
			requestId: id,
			status: 502,
			type: "llm_api_error",
		}),
		rateLimit,
	);
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const admissionClient = options.admissionClient ?? durableObjectAdmissionClient;
	const checkDependencies = options.dependencyHealthService ?? dependencyHealthService;
	const identityService = options.identityService ?? postgresIdentityService;
	const supportService = options.supportService ?? postgresSupportService;
	const usageService = options.usageService ?? postgresUsageService;
	const callLlmApi = options.llmApiFetch ?? fetch;
	const operationalLogger = options.operationalLogger ?? consoleOperationalLogger;
	const providerPoolClient = options.providerPoolClient ?? durableObjectProviderPoolClient;
	const providerRequestLimits: ProviderRequestLimits = {
		...DEFAULT_PROVIDER_REQUEST_LIMITS,
		...options.providerRequestLimits,
	};
	const finishRequestLifecycle = (
		c: Context<AppEnv>,
		endpoint: OperationalEventInput["endpoint"],
		id: string,
		startedAt: number,
		startedAtDate: Date,
		status: number,
	): void => {
		const failureCategory = c.get("failureCategory") ?? failureCategoryForStatus(status);
		const accountId = c.get("accountId");
		const apiKeyId = c.get("apiKeyId");
		emitOperationalEvent(operationalLogger, {
			account_id: accountId,
			duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
			endpoint,
			event: "request_finished",
			failure_category: failureCategory,
			http_status: status,
			key_id: apiKeyId,
			method: c.req.method,
			outcome: status < 400 && !failureCategory ? "succeeded" : "failed",
			request_id: id,
		});
		const traceEndpoint = requestTraceEndpoint(endpoint);
		if (
			!traceEndpoint ||
			!accountId ||
			!apiKeyId ||
			c.env.SENKO_AUTH_MODE?.trim() !== "database" ||
			!c.env.SENKO_DATABASE_URL?.trim() ||
			!c.env.SENKO_API_KEY_HASH_SECRET_V1?.trim()
		) {
			return;
		}
		const persistence = supportService
			.recordRequest(c.env, {
				accountId,
				apiKeyId,
				completedAt: new Date(),
				endpoint: traceEndpoint,
				failureCategory,
				httpStatus: status,
				method: c.req.method as "GET" | "POST",
				requestId: id,
				startedAt: startedAtDate,
			})
			.then((result) => {
				emitOperationalEvent(operationalLogger, {
					account_id: accountId,
					event: "request_trace_persistence",
					failure_category: result.ok
						? undefined
						: result.reason === "configuration_error"
							? "configuration"
							: "internal",
					key_id: apiKeyId,
					outcome: result.ok ? "succeeded" : "failed",
					request_id: id,
					terminal_reason: result.ok ? undefined : result.reason,
				});
			});
		try {
			c.executionCtx.waitUntil(persistence);
		} catch {
			void persistence;
		}
	};

	app.use("*", async (c, next) => {
		const id = requestId();
		const startedAt = performance.now();
		const startedAtDate = new Date();
		c.set("requestId", id);
		c.set("requestStartedAt", startedAt);
		c.set("requestStartedAtDate", startedAtDate);
		const endpoint = endpointFor(c.req.method, c.req.path);
		emitOperationalEvent(operationalLogger, {
			endpoint,
			event: "request_started",
			method: c.req.method,
			outcome: "started",
			request_id: id,
		});
		try {
			await next();
			c.res.headers.set("x-request-id", id);
		} finally {
			if (!c.get("requestCompletionDeferred")) {
				finishRequestLifecycle(c, endpoint, id, startedAt, startedAtDate, c.res?.status ?? 500);
			}
		}
	});

	app.get("/", (c) => c.json({ name: "Senko API", status: "ok" }));
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/openapi.json", (c) =>
		c.body(JSON.stringify(openApiDocument), 200, {
			"cache-control": "public, max-age=300",
			"content-type": "application/json; charset=UTF-8",
		}),
	);

	app.use("/admin/v1/*", async (c, next) => {
		const id = c.get("requestId");
		const adminToken = c.env.SENKO_ADMIN_TOKEN?.trim();
		if (!adminToken || new TextEncoder().encode(adminToken).byteLength < 32) {
			return apiError({
				code: "configuration_error",
				message: "Set SENKO_ADMIN_TOKEN to a secret containing at least 32 bytes before using management endpoints.",
				requestId: id,
				status: 503,
				type: "server_error",
			});
		}
		if (!(await authenticateSecret(c.req.header("authorization"), adminToken))) {
			return apiError({
				code: "invalid_admin_token",
				message: "Invalid management authentication credentials.",
				requestId: id,
				status: 401,
				type: "authentication_error",
			});
		}
		await next();
	});

	app.get("/admin/v1/dependency-health", async (c) => {
		const health = await checkDependencies.check(c.env).catch(() => ({
			checks: {
				admission: "failed" as const,
				configuration: "failed" as const,
				identity_storage: "failed" as const,
				provider_capacity: "failed" as const,
				usage_ledger: "failed" as const,
			},
			status: "unhealthy" as const,
		}));
		if (health.status !== "ok") c.set("failureCategory", "configuration");
		return c.json(
			{
				checks: health.checks,
				object: "dependency_health",
				status: health.status,
			},
			health.status === "ok" ? 200 : 503,
			noStoreHeaders(),
		);
	});

	app.get("/admin/v1/requests/:requestId", async (c) => {
		const id = c.get("requestId");
		const requestedId = c.req.param("requestId");
		if (!validRequestId(requestedId)) {
			return apiError({
				code: "invalid_request_id",
				message: "requestId must be a Senko request ID.",
				param: "requestId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const trace = await supportService.lookupRequest(c.env, requestedId);
		if (!trace.ok) {
			return supportFailureResponse(trace, operationalLogger, id);
		}
		emitOperationalEvent(operationalLogger, {
			candidates: trace.value.attempts.length,
			event: "support_lookup_completed",
			outcome: "succeeded",
			request_id: id,
		});
		return c.json(
			{
				account_id: trace.value.accountId,
				api_key_id: trace.value.apiKeyId,
				attempts: trace.value.attempts.map((attempt) => ({
					account_id: attempt.accountId,
					api_key_id: attempt.apiKeyId,
					attempt_id: attempt.attemptId,
					created_at: attempt.createdAt,
					currency: attempt.currency,
					estimated_input_tokens: attempt.estimatedInputTokens,
					ledger: attempt.ledger.map((entry) => ({
						created_at: entry.createdAt,
						event_type: entry.eventType,
						phase: entry.phase,
						released_cost_microunits: entry.releasedCostMicrounits,
						released_input_tokens: entry.releasedInputTokens,
						released_output_tokens: entry.releasedOutputTokens,
						reserved_cost_microunits: entry.reservedCostMicrounits,
						reserved_input_tokens: entry.reservedInputTokens,
						reserved_output_tokens: entry.reservedOutputTokens,
						settled_cost_microunits: entry.settledCostMicrounits,
						settled_input_tokens: entry.settledInputTokens,
						settled_output_tokens: entry.settledOutputTokens,
						terminal_reason: entry.terminalReason,
						usage_source: entry.usageSource,
					})),
					pending_reservation: attempt.pendingReservation,
					policy_version: attempt.policyVersion,
					pricing_version: attempt.pricingVersion,
					protocol: attempt.protocol,
					provider_attempt: attempt.providerAttempt,
					provider_route: attempt.providerRoute,
					requested_model: attempt.requestedModel,
					reservation_expires_at: attempt.reservationExpiresAt,
					reserved_cost_microunits: attempt.reservedCostMicrounits,
					reserved_output_tokens: attempt.reservedOutputTokens,
					resolved_model: attempt.resolvedModel,
				})),
				completed_at: trace.value.completedAt,
				endpoint: trace.value.endpoint,
				failure_category: trace.value.failureCategory,
				has_more: trace.value.hasMore,
				http_status: trace.value.httpStatus,
				method: trace.value.method,
				object: "request_trace",
				request_id: trace.value.requestId,
				started_at: trace.value.startedAt,
			},
			200,
			noStoreHeaders(),
		);
	});

	app.post("/admin/v1/accounts", async (c) => {
		const id = c.get("requestId");
		const body = await readBoundedJson(c.req.raw);
		if (!body.ok) {
			return apiError({
				code: body.reason,
				message:
					body.reason === "request_too_large"
						? "The request body exceeds the 1 MiB limit."
						: "The request body must be valid JSON.",
				requestId: id,
				status: body.reason === "request_too_large" ? 413 : 400,
				type: "invalid_request_error",
			});
		}
		const input = parseCreateAccountRequest(body.value);
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const created = await identityService.createAccount(c.env, { ...input.value, requestId: id });
		if (!created.ok) {
			return identityFailureResponse(created, operationalLogger, id);
		}
		return c.json(accountResponse(created.value), 201, noStoreHeaders());
	});

	app.get("/admin/v1/accounts", async (c) => {
		const id = c.get("requestId");
		const input = parseListAccountsRequest(c.req.query("limit"), c.req.query("starting_after"));
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const listed = await identityService.listAccounts(c.env, input.value);
		if (!listed.ok) {
			return identityFailureResponse(listed, operationalLogger, id);
		}
		return c.json(
			{
				data: listed.value.data.map(accountResponse),
				has_more: listed.value.hasMore,
				next_starting_after:
					listed.value.hasMore && listed.value.data.length > 0
						? listed.value.data[listed.value.data.length - 1]?.id
						: null,
				object: "list",
			},
			200,
			noStoreHeaders(),
		);
	});

	app.get("/admin/v1/accounts/:accountId/audit-events", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		if (!validUuid(accountId)) {
			return apiError({
				code: "invalid_account_id",
				message: "accountId must be a UUID.",
				param: "accountId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const input = parseListAuditEventsRequest(c.req.query("limit"), c.req.query("starting_after"));
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const listed = await identityService.listAuditEvents(c.env, { ...input.value, accountId });
		if (!listed.ok) {
			return identityFailureResponse(listed, operationalLogger, id);
		}
		return c.json(
			{
				data: listed.value.data.map(auditEventResponse),
				has_more: listed.value.hasMore,
				next_starting_after:
					listed.value.hasMore && listed.value.data.length > 0
						? listed.value.data[listed.value.data.length - 1]?.id
						: null,
				object: "list",
			},
			200,
			noStoreHeaders(),
		);
	});

	app.post("/admin/v1/accounts/:accountId/teams", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		if (!validUuid(accountId)) {
			return apiError({
				code: "invalid_account_id",
				message: "accountId must be a UUID.",
				param: "accountId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const body = await readBoundedJson(c.req.raw);
		if (!body.ok) {
			return apiError({
				code: body.reason,
				message:
					body.reason === "request_too_large"
						? "The request body exceeds the 1 MiB limit."
						: "The request body must be valid JSON.",
				requestId: id,
				status: body.reason === "request_too_large" ? 413 : 400,
				type: "invalid_request_error",
			});
		}
		const input = parseCreateTeamRequest(body.value);
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const created = await identityService.createTeam(c.env, { ...input.value, accountId, requestId: id });
		if (!created.ok) {
			return identityFailureResponse(created, operationalLogger, id);
		}
		return c.json(teamResponse(created.value), 201, noStoreHeaders());
	});

	app.get("/admin/v1/accounts/:accountId/teams", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		if (!validUuid(accountId)) {
			return apiError({
				code: "invalid_account_id",
				message: "accountId must be a UUID.",
				param: "accountId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const input = parseListTeamsRequest(c.req.query("limit"), c.req.query("starting_after"));
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const listed = await identityService.listTeams(c.env, { ...input.value, accountId });
		if (!listed.ok) {
			return identityFailureResponse(listed, operationalLogger, id);
		}
		return c.json(
			{
				data: listed.value.data.map(teamResponse),
				has_more: listed.value.hasMore,
				next_starting_after:
					listed.value.hasMore && listed.value.data.length > 0
						? listed.value.data[listed.value.data.length - 1]?.id
						: null,
				object: "list",
			},
			200,
			noStoreHeaders(),
		);
	});

	for (const [path, status] of [
		["/admin/v1/accounts/:accountId/teams/:teamId/archive", "archived"],
		["/admin/v1/accounts/:accountId/teams/:teamId/reactivate", "active"],
	] as const) {
		app.post(path, async (c) => {
			const id = c.get("requestId");
			const accountId = c.req.param("accountId");
			const teamId = c.req.param("teamId");
			if (!validUuid(accountId) || !validUuid(teamId)) {
				const invalidParameter = !validUuid(accountId) ? "accountId" : "teamId";
				return apiError({
					code: `invalid_${invalidParameter === "accountId" ? "account" : "team"}_id`,
					message: `${invalidParameter} must be a UUID.`,
					param: invalidParameter,
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
			}
			const updated = await identityService.setTeamStatus(c.env, {
				accountId,
				requestId: id,
				status,
				teamId,
			});
			if (!updated.ok) {
				return identityFailureResponse(updated, operationalLogger, id);
			}
			return c.json(teamResponse(updated.value), 200, noStoreHeaders());
		});
	}

	for (const [path, status] of [
		["/admin/v1/accounts/:accountId/suspend", "suspended"],
		["/admin/v1/accounts/:accountId/reactivate", "active"],
	] as const) {
		app.post(path, async (c) => {
			const id = c.get("requestId");
			const accountId = c.req.param("accountId");
			if (!validUuid(accountId)) {
				return apiError({
					code: "invalid_account_id",
					message: "accountId must be a UUID.",
					param: "accountId",
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
			}
			const updated = await identityService.setAccountStatus(c.env, { accountId, requestId: id, status });
			if (!updated.ok) {
				return identityFailureResponse(updated, operationalLogger, id);
			}
			return c.json(accountResponse(updated.value), 200, noStoreHeaders());
		});
	}

	app.post("/admin/v1/accounts/:accountId/api-keys", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		if (!validUuid(accountId)) {
			return apiError({
				code: "invalid_account_id",
				message: "accountId must be a UUID.",
				param: "accountId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const body = await readBoundedJson(c.req.raw);
		if (!body.ok) {
			return apiError({
				code: body.reason,
				message:
					body.reason === "request_too_large"
						? "The request body exceeds the 1 MiB limit."
						: "The request body must be valid JSON.",
				requestId: id,
				status: body.reason === "request_too_large" ? 413 : 400,
				type: "invalid_request_error",
			});
		}
		const input = parseIssueApiKeyRequest(body.value);
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const issued = await identityService.issueApiKey(c.env, {
			...input.value,
			accountId,
			requestId: id,
		});
		if (!issued.ok) {
			return identityFailureResponse(issued, operationalLogger, id);
		}
		return c.json(
			{
				...apiKeyResponse(issued.value),
				key: issued.value.key,
				warning: "Save this key now. It cannot be retrieved again.",
			},
			201,
			noStoreHeaders(),
		);
	});

	app.get("/admin/v1/accounts/:accountId/api-keys", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		if (!validUuid(accountId)) {
			return apiError({
				code: "invalid_account_id",
				message: "accountId must be a UUID.",
				param: "accountId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const input = parseListApiKeysRequest(c.req.query("limit"), c.req.query("starting_after"));
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const listed = await identityService.listApiKeys(c.env, { ...input.value, accountId });
		if (!listed.ok) {
			return identityFailureResponse(listed, operationalLogger, id);
		}
		return c.json(
			{
				data: listed.value.data.map(apiKeyResponse),
				has_more: listed.value.hasMore,
				next_starting_after:
					listed.value.hasMore && listed.value.data.length > 0
						? listed.value.data[listed.value.data.length - 1]?.id
						: null,
				object: "list",
			},
			200,
			noStoreHeaders(),
		);
	});

	app.put("/admin/v1/accounts/:accountId/usage-limits", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		if (!validUuid(accountId)) {
			return apiError({
				code: "invalid_account_id",
				message: "accountId must be a UUID.",
				param: "accountId",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const body = await readBoundedJson(c.req.raw);
		if (!body.ok) {
			return apiError({
				code: body.reason,
				message:
					body.reason === "request_too_large"
						? "The request body exceeds the 1 MiB limit."
						: "The request body must be valid JSON.",
				requestId: id,
				status: body.reason === "request_too_large" ? 413 : 400,
				type: "invalid_request_error",
			});
		}
		const input = parseConfigureUsageLimitsRequest(body.value);
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const configured = await usageService.configureLimits(c.env, { ...input.value, accountId, requestId: id });
		if (!configured.ok) {
			return usageManagementFailureResponse(configured, operationalLogger, id);
		}
		return c.json(
			{
				account_id: configured.value.accountId,
				currency: configured.value.currency,
				daily_cost_microunits: configured.value.dailyCostMicrounits,
				max_request_cost_microunits: configured.value.maxRequestCostMicrounits,
				minute_input_tokens: configured.value.minuteInputTokens,
				minute_output_tokens: configured.value.minuteOutputTokens,
				monthly_cost_microunits: configured.value.monthlyCostMicrounits,
				object: "account_usage_limits",
				policy_version: configured.value.policyVersion,
			},
			200,
			noStoreHeaders(),
		);
	});

	app.put("/admin/v1/accounts/:accountId/api-keys/:keyId/usage-limits", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		const apiKeyId = c.req.param("keyId");
		if (!validUuid(accountId) || !validUuid(apiKeyId)) {
			return apiError({
				code: "invalid_identifier",
				message: "accountId and keyId must be UUIDs.",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const body = await readBoundedJson(c.req.raw);
		if (!body.ok) {
			return apiError({
				code: body.reason,
				message:
					body.reason === "request_too_large"
						? "The request body exceeds the 1 MiB limit."
						: "The request body must be valid JSON.",
				requestId: id,
				status: body.reason === "request_too_large" ? 413 : 400,
				type: "invalid_request_error",
			});
		}
		const input = parseConfigureUsageLimitsRequest(body.value);
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const configured = await usageService.configureApiKeyLimits(c.env, {
			...input.value,
			accountId,
			apiKeyId,
			requestId: id,
		});
		if (!configured.ok) {
			return usageManagementFailureResponse(configured, operationalLogger, id);
		}
		return c.json(
			{
				account_id: configured.value.accountId,
				api_key_id: configured.value.apiKeyId,
				currency: configured.value.currency,
				daily_cost_microunits: configured.value.dailyCostMicrounits,
				max_request_cost_microunits: configured.value.maxRequestCostMicrounits,
				minute_input_tokens: configured.value.minuteInputTokens,
				minute_output_tokens: configured.value.minuteOutputTokens,
				monthly_cost_microunits: configured.value.monthlyCostMicrounits,
				object: "api_key_usage_limits",
				policy_version: configured.value.policyVersion,
			},
			200,
			noStoreHeaders(),
		);
	});

	app.post("/admin/v1/accounts/:accountId/api-keys/:keyId/revoke", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		const keyId = c.req.param("keyId");
		if (!validUuid(accountId) || !validUuid(keyId)) {
			return apiError({
				code: "invalid_identifier",
				message: "accountId and keyId must be UUIDs.",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const revoked = await identityService.revokeApiKey(c.env, { accountId, keyId, requestId: id });
		if (!revoked.ok) {
			return identityFailureResponse(revoked, operationalLogger, id);
		}
		return c.json(apiKeyResponse(revoked.value), 200, noStoreHeaders());
	});

	app.post("/admin/v1/accounts/:accountId/api-keys/:keyId/rotate", async (c) => {
		const id = c.get("requestId");
		const accountId = c.req.param("accountId");
		const keyId = c.req.param("keyId");
		if (!validUuid(accountId) || !validUuid(keyId)) {
			return apiError({
				code: "invalid_identifier",
				message: "accountId and keyId must be UUIDs.",
				requestId: id,
				status: 400,
				type: "invalid_request_error",
			});
		}
		const body = await readBoundedJson(c.req.raw);
		if (!body.ok) {
			return apiError({
				code: body.reason,
				message:
					body.reason === "request_too_large"
						? "The request body exceeds the 1 MiB limit."
						: "The request body must be valid JSON.",
				requestId: id,
				status: body.reason === "request_too_large" ? 413 : 400,
				type: "invalid_request_error",
			});
		}
		const input = parseRotateApiKeyRequest(body.value);
		if (!input.ok) {
			return apiError({ ...input, requestId: id, status: 400, type: "invalid_request_error" });
		}
		const rotated = await identityService.rotateApiKey(c.env, { ...input.value, accountId, keyId, requestId: id });
		if (!rotated.ok) {
			return identityFailureResponse(rotated, operationalLogger, id);
		}
		return c.json(
			{
				...apiKeyResponse(rotated.value),
				key: rotated.value.key,
				warning: "Save this key now. It cannot be retrieved again. The replaced key remains active until revoked.",
			},
			201,
			noStoreHeaders(),
		);
	});

	app.use("/v1/*", async (c, next) => {
		const id = c.get("requestId");
		const mode = getAuthenticationMode(c.env);
		if (!mode.ok) {
			emitOperationalEvent(operationalLogger, {
				event: "authentication_completed",
				failure_category: "configuration",
				outcome: "failed",
				request_id: id,
			});
			return apiError({
				code: "configuration_error",
				message: mode.message,
				requestId: id,
				status: 503,
				type: "server_error",
			});
		}
		let apiKeyId: string;
		let scopes: ApiKeyScope[];
		if (mode.value === "bootstrap") {
			if (!c.env.SENKO_API_KEYS?.trim()) {
				emitOperationalEvent(operationalLogger, {
					event: "authentication_completed",
					failure_category: "configuration",
					outcome: "failed",
					request_id: id,
				});
				return apiError({
					code: "configuration_error",
					message: "Set SENKO_API_KEYS when SENKO_AUTH_MODE is bootstrap.",
					requestId: id,
					status: 503,
					type: "server_error",
				});
			}
			const bootstrapKey = await authenticate(c.req.header("authorization"), c.env.SENKO_API_KEYS);
			if (!bootstrapKey) {
				emitOperationalEvent(operationalLogger, {
					event: "authentication_completed",
					failure_category: "authentication",
					outcome: "denied",
					request_id: id,
				});
				return apiError({
					code: "invalid_api_key",
					message: "Invalid authentication credentials.",
					requestId: id,
					status: 401,
					type: "authentication_error",
				});
			}
			apiKeyId = bootstrapKey.id;
			scopes = ["models:read", "inference:chat", "inference:responses"];
		} else {
			const databaseKey = await identityService.authenticate(c.env, c.req.header("authorization"));
			if (!databaseKey.ok) {
				emitOperationalEvent(operationalLogger, {
					event: "authentication_completed",
					failure_category:
						databaseKey.reason === "configuration_error"
							? "configuration"
							: databaseKey.reason === "unavailable"
								? "internal"
								: "authentication",
					outcome:
						databaseKey.reason === "configuration_error" || databaseKey.reason === "unavailable" ? "failed" : "denied",
					request_id: id,
				});
				if (databaseKey.reason === "configuration_error" || databaseKey.reason === "unavailable") {
					return identityFailureResponse(databaseKey, operationalLogger, id);
				}
				return apiError({
					code: "invalid_api_key",
					message: "Invalid authentication credentials.",
					requestId: id,
					status: 401,
					type: "authentication_error",
				});
			}
			apiKeyId = databaseKey.value.keyId;
			scopes = databaseKey.value.scopes;
			c.set("accountId", databaseKey.value.accountId);
			const touch = identityService.touchLastUsed(c.env, databaseKey.value.keyId).then((result) => {
				if (!result.ok) {
					emitOperationalEvent(operationalLogger, {
						account_id: databaseKey.value.accountId,
						event: "api_key_last_used_update",
						failure_category: "internal",
						key_id: databaseKey.value.keyId,
						outcome: "failed",
						request_id: id,
						terminal_reason: result.reason,
					});
				}
			});
			try {
				c.executionCtx.waitUntil(touch);
			} catch {
				void touch;
			}
		}

		const requiredScope = REQUIRED_SCOPES.get(`${c.req.method} ${c.req.path}`);
		c.set("apiKeyId", apiKeyId);
		if (requiredScope && !scopes.includes(requiredScope)) {
			emitOperationalEvent(operationalLogger, {
				account_id: c.get("accountId"),
				event: "authentication_completed",
				failure_category: "authentication",
				key_id: apiKeyId,
				outcome: "denied",
				request_id: id,
			});
			return apiError({
				code: "insufficient_scope",
				message: `The API key does not grant the required ${requiredScope} scope.`,
				requestId: id,
				status: 403,
				type: "permission_error",
			});
		}
		c.set("apiKeyScopes", scopes);
		emitOperationalEvent(operationalLogger, {
			account_id: c.get("accountId"),
			event: "authentication_completed",
			key_id: apiKeyId,
			outcome: "succeeded",
			request_id: id,
		});
		await next();
	});

	app.get("/v1/models", (c) => {
		const id = c.get("requestId");
		const catalog = getModelCatalog(c.env);
		if (!catalog.ok) {
			return apiError({
				code: "configuration_error",
				message: catalog.message,
				requestId: id,
				status: 503,
				type: "server_error",
			});
		}
		return c.json(
			{
				data: [modelResponse(catalog.value.fast, "fast"), ...catalog.value.models.map((model) => modelResponse(model))],
				object: "list",
			},
			200,
			{ "cache-control": "no-store", "x-request-id": id },
		);
	});

	const forward = async (c: Context<AppEnv>, protocol: ApiProtocol): Promise<Response> => {
		const id = c.get("requestId");
		const inferenceEnabled = getInferenceEnabled(c.env);
		if (!inferenceEnabled.ok) {
			return apiError({
				code: "configuration_error",
				message: inferenceEnabled.message,
				requestId: id,
				status: 503,
				type: "server_error",
			});
		}
		if (!inferenceEnabled.value) {
			emitOperationalEvent(operationalLogger, {
				event: "inference_kill_switch",
				failure_category: "internal",
				outcome: "denied",
				request_id: id,
			});
			return apiError({
				code: "inference_disabled",
				message: "Inference is temporarily disabled by Senko.",
				requestId: id,
				status: 503,
				type: "server_error",
			});
		}
		const deadlineAt = Date.now() + providerRequestLimits.totalTimeoutMs;
		const keyId = c.get("apiKeyId");
		const databaseAccountId = c.get("accountId");
		const accountId = databaseAccountId ?? keyId;
		const admission = await admissionClient.acquire(c.env, accountId, keyId, id, deadlineAt);
		if (!admission.ok) {
			const configurationError = admission.reason === "configuration_error";
			const unavailable = admission.reason === "admission_unavailable";
			c.set("failureCategory", configurationError ? "configuration" : unavailable ? "admission" : "quota");
			const response = apiError({
				code: configurationError
					? "configuration_error"
					: unavailable
						? "admission_unavailable"
						: "rate_limit_exceeded",
				message: configurationError
					? "Configure the SENKO_ADMISSION Durable Object binding before serving inference requests."
					: unavailable
						? "Inference admission control is temporarily unavailable."
						: "The inference request limit has been reached. Retry later.",
				requestId: id,
				status: configurationError || unavailable ? 503 : 429,
				type: configurationError || unavailable ? "server_error" : "rate_limit_error",
			});
			emitOperationalEvent(operationalLogger, {
				account_id: accountId,
				event: "admission_completed",
				failure_category: configurationError ? "configuration" : unavailable ? "admission" : "quota",
				key_id: keyId,
				outcome: configurationError || unavailable ? "failed" : "denied",
				request_id: id,
			});
			if ("rateLimit" in admission) {
				response.headers.set("retry-after", String(admission.retryAfterSeconds));
				applyRateLimitHeaders(response.headers, admission.rateLimit);
			}
			return response;
		}
		emitOperationalEvent(operationalLogger, {
			account_id: accountId,
			event: "admission_completed",
			key_id: keyId,
			outcome: "allowed",
			request_id: id,
		});

		let admissionFinished = false;
		let leaseLost = false;
		let providerControl: ProviderRequestControl | undefined;
		const finishAdmission = async (): Promise<void> => {
			if (admissionFinished) {
				return;
			}
			admissionFinished = true;
			heartbeat.stop();
			let released = false;
			try {
				released = await admissionClient.release(c.env, admission.leaseId);
			} catch {
				released = false;
			}
			if (!released) {
				logAdmissionFailure(operationalLogger, "admission_lease_release", id);
			}
		};
		const heartbeat = startAdmissionHeartbeat({
			admissionClient,
			env: c.env,
			leaseExpiresAt: admission.leaseExpiresAt,
			leaseId: admission.leaseId,
			logger: operationalLogger,
			onLost: () => {
				leaseLost = true;
				providerControl?.abort("admission_lost");
			},
			requestId: id,
		});
		let releaseImmediately = true;
		let providerRequestStarted = false;
		let providerPoolFinished = false;
		let providerPoolHeartbeat: { stop(): void } | undefined;
		let providerPoolLost = false;
		let providerPoolOutcome: ProviderPoolReleaseOutcome = "not_started";
		let providerPoolRouteId: string | undefined;
		const finishProviderPool = async (): Promise<void> => {
			if (!providerPoolRouteId || providerPoolFinished) return;
			providerPoolFinished = true;
			providerPoolHeartbeat?.stop();
			let result: Awaited<ReturnType<ProviderPoolClient["release"]>>;
			try {
				result = await providerPoolClient.release(c.env, providerPoolRouteId, id, providerPoolOutcome);
			} catch {
				result = undefined;
			}
			emitOperationalEvent(operationalLogger, {
				circuit_open_until: result?.circuitOpenUntil,
				consecutive_failures: result?.consecutiveFailures,
				event: "provider_pool_release",
				failure_category: result ? undefined : "provider_capacity",
				outcome: result ? "succeeded" : "failed",
				provider_route: providerPoolRouteId,
				request_id: id,
			});
		};
		let usageFinalizationScheduled = false;
		let usageReservation: UsageReservation | undefined;
		const finalizeUsage = (
			kind: "conservative_settled" | "released" | "settled",
			terminalReason: string,
			usage?: ProviderUsage,
		): void => {
			if (!usageReservation || usageFinalizationScheduled || (kind === "settled" && !usage)) {
				return;
			}
			usageFinalizationScheduled = true;
			const common = {
				accountId: usageReservation.accountId,
				attemptId: usageReservation.attemptId,
				terminalReason,
			};
			const input: FinalizeUsageInput =
				kind === "settled" ? { ...common, kind, usage: usage as ProviderUsage } : { ...common, kind };
			scheduleUsageFinalization(c, usageService, input, operationalLogger, id);
		};
		try {
			const parsedBody = await readBoundedJson(c.req.raw);
			if (!parsedBody.ok) {
				return withRateLimit(
					apiError({
						code: parsedBody.reason,
						message:
							parsedBody.reason === "request_too_large"
								? "The request body exceeds the 1 MiB limit."
								: "The request body must be valid JSON.",
						param: null,
						requestId: id,
						status: parsedBody.reason === "request_too_large" ? 413 : 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}
			const body = parsedBody.value;
			if (!isRecord(body) || typeof body.model !== "string" || body.model.trim() === "") {
				return withRateLimit(
					apiError({
						code: "invalid_model",
						message: "The model field must be a non-empty string.",
						param: "model",
						requestId: id,
						status: 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}

			const catalog = getModelCatalog(c.env);
			if (!catalog.ok) {
				return withRateLimit(
					apiError({
						code: "configuration_error",
						message: catalog.message,
						requestId: id,
						status: 503,
						type: "server_error",
					}),
					admission.rateLimit,
				);
			}
			const requestedModel = body.model.trim();
			const model = requestedModel === "fast" ? catalog.value.fast : catalog.value.byId.get(requestedModel);
			if (!model || !model.supported_protocols.includes(protocol)) {
				return withRateLimit(
					apiError({
						code: "invalid_model",
						message: `Model "${requestedModel}" is not available for this API protocol.`,
						param: "model",
						requestId: id,
						status: 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}
			const tokenParam = outputTokenParam(body, protocol);
			if (!tokenParam) {
				return withRateLimit(
					apiError({
						code: "invalid_max_output_tokens",
						message: "Set only one of max_completion_tokens or max_tokens.",
						param: "max_completion_tokens",
						requestId: id,
						status: 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}
			const maxOutputTokens = Math.min(model.max_output_tokens, MAX_OUTPUT_TOKENS_PER_REQUEST);
			const requestedOutputTokens = body[tokenParam];
			if (
				requestedOutputTokens !== undefined &&
				(typeof requestedOutputTokens !== "number" ||
					!Number.isSafeInteger(requestedOutputTokens) ||
					requestedOutputTokens <= 0 ||
					requestedOutputTokens > maxOutputTokens)
			) {
				return withRateLimit(
					apiError({
						code: "invalid_max_output_tokens",
						message: `${tokenParam} must be a positive integer no greater than ${maxOutputTokens}.`,
						param: tokenParam,
						requestId: id,
						status: 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}
			if (protocol === "openai-completions" && body.n !== undefined && body.n !== 1) {
				return withRateLimit(
					apiError({
						code: "unsupported_choice_count",
						message: "Senko supports exactly one Chat Completions choice per request.",
						param: "n",
						requestId: id,
						status: 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}
			const normalizedRequest = normalizeLlmApiRequest({ body, maxOutputTokens, model, protocol, tokenParam });
			if (!normalizedRequest.ok) {
				return withRateLimit(
					apiError({
						...normalizedRequest.error,
						requestId: id,
						status: 400,
						type: "invalid_request_error",
					}),
					admission.rateLimit,
				);
			}

			const providerRoutes = getProviderRouteCandidates(c.env, model.id, protocol);
			if (!providerRoutes.ok) {
				return withRateLimit(
					apiError({
						code: "configuration_error",
						message: providerRoutes.message,
						requestId: id,
						status: 503,
						type: "server_error",
					}),
					admission.rateLimit,
				);
			}
			const normalizedOutputTokens = normalizedRequest.value[tokenParam];
			if (typeof normalizedOutputTokens !== "number") {
				throw new Error("normalized output token limit is missing");
			}
			const estimatedInputTokens = estimateInputTokens(normalizedRequest.value);
			const providerReservedTokens = estimatedInputTokens + normalizedOutputTokens;
			let providerRoute: ProviderRoute | undefined;
			let providerPoolRetryAfter: number | undefined;
			let providerPoolConfigurationError = false;
			for (const candidate of providerRoutes.value) {
				if (!candidate.capacity) {
					providerRoute = candidate;
					break;
				}
				const pool = await providerPoolClient.acquire(
					c.env,
					candidate.id,
					candidate.capacity,
					id,
					providerReservedTokens,
					deadlineAt,
				);
				emitOperationalEvent(operationalLogger, {
					account_id: databaseAccountId,
					circuit_open_until: "circuitOpenUntil" in pool ? pool.circuitOpenUntil : undefined,
					event: "provider_pool_admission",
					failure_category: pool.ok
						? undefined
						: pool.reason === "configuration_error"
							? "configuration"
							: "provider_capacity",
					key_id: keyId,
					model: model.id,
					outcome: pool.ok
						? "allowed"
						: pool.reason === "configuration_error" || pool.reason === "provider_pool_unavailable"
							? "failed"
							: "denied",
					protocol,
					provider_route: candidate.id,
					remaining_concurrent_requests:
						"remainingConcurrentRequests" in pool ? pool.remainingConcurrentRequests : undefined,
					remaining_provider_requests: "remainingRequests" in pool ? pool.remainingRequests : undefined,
					remaining_provider_tokens: "remainingTokens" in pool ? pool.remainingTokens : undefined,
					request_id: id,
					retry_after_seconds: pool.ok ? undefined : pool.retryAfterSeconds,
					terminal_reason: pool.ok ? undefined : pool.reason,
				});
				if (pool.ok) {
					providerRoute = candidate;
					providerPoolRouteId = candidate.id;
					providerPoolHeartbeat = startProviderPoolHeartbeat({
						env: c.env,
						leaseExpiresAt: pool.leaseExpiresAt,
						leaseId: pool.leaseId,
						logger: operationalLogger,
						onLost: () => {
							providerPoolLost = true;
							providerControl?.abort("provider_pool_lost");
						},
						providerPoolClient,
						requestId: id,
						routeId: candidate.id,
					});
					break;
				}
				providerPoolRetryAfter = Math.max(
					1,
					Math.min(providerPoolRetryAfter ?? pool.retryAfterSeconds, pool.retryAfterSeconds),
				);
				if (pool.reason === "configuration_error") {
					providerPoolConfigurationError = true;
					break;
				}
			}
			if (!providerRoute) {
				c.set("failureCategory", providerPoolConfigurationError ? "configuration" : "provider_capacity");
				const response = withRateLimit(
					apiError({
						code: providerPoolConfigurationError ? "configuration_error" : "provider_capacity_unavailable",
						message: providerPoolConfigurationError
							? "Configure the SENKO_PROVIDER_POOLS Durable Object binding before using explicit provider routes."
							: "No configured provider route currently has available capacity.",
						requestId: id,
						status: 503,
						type: "server_error",
					}),
					admission.rateLimit,
				);
				response.headers.set("retry-after", String(providerPoolRetryAfter ?? 1));
				return response;
			}
			const providerRequest: Record<string, unknown> = {
				...normalizedRequest.value,
				model: providerRoute.providerModel,
			};
			emitOperationalEvent(operationalLogger, {
				account_id: databaseAccountId,
				event: "provider_route_selected",
				key_id: keyId,
				model: model.id,
				outcome: "succeeded",
				protocol,
				provider_attempt: 0,
				provider_route: providerRoute.id,
				request_id: id,
			});
			if (databaseAccountId) {
				if (!model.pricing) {
					c.set("failureCategory", "configuration");
					return withRateLimit(
						apiError({
							code: "configuration_error",
							message:
								"Configure pricing for the selected model before serving database-authenticated inference requests.",
							requestId: id,
							status: 503,
							type: "server_error",
						}),
						admission.rateLimit,
					);
				}
				const reservation = await usageService.reserve(c.env, {
					accountId: databaseAccountId,
					apiKeyId: keyId,
					estimatedInputTokens,
					pricing: model.pricing,
					providerAttempt: 0,
					providerRoute: providerRoute.id,
					protocol,
					requestId: id,
					requestedModel,
					reservationExpiresAt: new Date(deadlineAt + 60_000),
					reservedOutputTokens: normalizedOutputTokens,
					resolvedModel: model.id,
				});
				if (!reservation.ok) {
					c.set("failureCategory", reservation.reason === "limit_exceeded" ? "quota" : "usage");
					emitOperationalEvent(operationalLogger, {
						account_id: databaseAccountId,
						event: "usage_reservation_completed",
						failure_category: reservation.reason === "limit_exceeded" ? "quota" : "usage",
						key_id: keyId,
						model: model.id,
						outcome: reservation.reason === "limit_exceeded" ? "denied" : "failed",
						protocol,
						provider_attempt: 0,
						provider_route: providerRoute.id,
						request_id: id,
						terminal_reason: reservation.reason,
					});
					return usageAdmissionFailureResponse(reservation, id, admission.rateLimit);
				}
				usageReservation = reservation.value;
				emitOperationalEvent(operationalLogger, {
					account_id: databaseAccountId,
					event: "usage_reservation_completed",
					key_id: keyId,
					model: model.id,
					outcome: "succeeded",
					protocol,
					provider_attempt: 0,
					provider_route: providerRoute.id,
					request_id: id,
					reserved_cost_microunits: reservation.value.reservedCostMicrounits,
				});
			}

			providerControl = createProviderRequestControl(c.req.raw.signal, deadlineAt, providerRequestLimits);
			if (leaseLost || providerPoolLost) {
				providerControl.abort(leaseLost ? "admission_lost" : "provider_pool_lost");
				finalizeUsage("released", leaseLost ? "admission_lost_before_provider" : "provider_pool_lost_before_provider");
				return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
			}
			const llmApiBody = JSON.stringify(providerRequest);
			const llmApiUrl = `${providerRoute.baseUrl}${pathForProtocol(protocol)}`;
			const providerStartedAt = performance.now();
			let providerCompletedLogged = false;
			let providerFirstByteLogged = false;
			let providerFirstTokenLogged = false;
			const markProviderFirstByte = (): void => {
				if (providerFirstByteLogged) return;
				providerFirstByteLogged = true;
				emitOperationalEvent(operationalLogger, {
					account_id: databaseAccountId,
					event: "provider_first_byte",
					key_id: keyId,
					model: model.id,
					outcome: "succeeded",
					protocol,
					provider_attempt: 0,
					provider_route: providerRoute.id,
					request_id: id,
					time_to_first_byte_ms: Math.max(0, Math.round(performance.now() - providerStartedAt)),
				});
			};
			const markProviderFirstToken = (): void => {
				if (providerFirstTokenLogged) return;
				providerFirstTokenLogged = true;
				emitOperationalEvent(operationalLogger, {
					account_id: databaseAccountId,
					event: "provider_first_token",
					key_id: keyId,
					model: model.id,
					outcome: "succeeded",
					protocol,
					provider_attempt: 0,
					provider_route: providerRoute.id,
					request_id: id,
					time_to_first_token_ms: Math.max(0, Math.round(performance.now() - providerStartedAt)),
				});
			};
			const completeProvider = (
				outcome: "failed" | "succeeded",
				terminalReason: string,
				status?: number,
				terminalErrorCode?: string,
			): void => {
				if (providerCompletedLogged) return;
				providerCompletedLogged = true;
				providerPoolOutcome = providerPoolReleaseOutcome(outcome, terminalReason, status, terminalErrorCode);
				const failureCategory = outcome === "failed" ? providerFailureCategory(terminalReason) : undefined;
				if (failureCategory) c.set("failureCategory", failureCategory);
				emitOperationalEvent(operationalLogger, {
					account_id: databaseAccountId,
					duration_ms: Math.max(0, Math.round(performance.now() - providerStartedAt)),
					event: "provider_completed",
					failure_category: failureCategory,
					http_status: status,
					key_id: keyId,
					model: model.id,
					outcome,
					protocol,
					provider_attempt: 0,
					provider_route: providerRoute.id,
					request_id: id,
					terminal_reason: terminalReason,
				});
			};
			let response: Response;
			try {
				providerRequestStarted = true;
				providerPoolOutcome = "neutral";
				response = await callLlmApi(llmApiUrl, {
					body: llmApiBody,
					headers: llmApiRequestHeaders(providerRoute.apiKey, id, body.stream === true),
					method: "POST",
					redirect: "error",
					signal: providerControl.signal,
				});
			} catch {
				completeProvider("failed", providerControl.reason ?? "provider_fetch_failed");
				finalizeUsage("conservative_settled", providerControl.reason ?? "provider_fetch_failed");
				return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
			}
			providerControl.markResponseStarted();
			emitOperationalEvent(operationalLogger, {
				account_id: databaseAccountId,
				duration_ms: Math.max(0, Math.round(performance.now() - providerStartedAt)),
				event: "provider_response_headers",
				failure_category: response.ok ? undefined : "provider_rejected",
				http_status: response.status,
				key_id: keyId,
				model: model.id,
				outcome: response.ok ? "succeeded" : "failed",
				protocol,
				provider_attempt: 0,
				provider_route: providerRoute.id,
				request_id: id,
			});
			if (!response.ok) {
				const jsonError = response.headers.get("content-type")?.includes("application/json") === true;
				const errorBody = jsonError
					? await readBoundedProviderJson(response.body, providerControl, undefined, markProviderFirstByte)
					: undefined;
				if (!jsonError) {
					await response.body?.cancel("non-JSON provider error");
				}
				if (providerControl.reason) {
					completeProvider("failed", providerControl.reason, response.status);
					finalizeUsage("conservative_settled", providerControl.reason);
					return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
				}
				completeProvider("failed", "provider_rejected_unknown_cost", response.status);
				finalizeUsage("conservative_settled", "provider_rejected_unknown_cost");
				return compatibleLlmApiError({
					body: errorBody,
					headers: response.headers,
					id,
					rateLimit: admission.rateLimit,
					status: response.status,
				});
			}
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			const expectedStream = body.stream === true;
			const compatibleContentType = expectedStream
				? contentType.includes("text/event-stream")
				: contentType.includes("application/json") || contentType.includes("+json");
			if (response.body && !compatibleContentType) {
				await response.body.cancel("incompatible provider content type");
				finalizeUsage("conservative_settled", "incompatible_provider_response");
				completeProvider("failed", "incompatible_provider_response", response.status);
				return withRateLimit(
					apiError({
						code: "invalid_llm_api_response",
						message: "The configured LLM API returned an incompatible content type.",
						requestId: id,
						status: 502,
						type: "llm_api_error",
					}),
					admission.rateLimit,
				);
			}
			if (!response.body) {
				finalizeUsage("conservative_settled", "missing_provider_body");
				completeProvider("failed", "missing_provider_body", response.status);
				return withRateLimit(
					apiError({
						code: "invalid_llm_api_response",
						message: "The configured LLM API returned an empty response.",
						requestId: id,
						status: 502,
						type: "llm_api_error",
					}),
					admission.rateLimit,
				);
			}
			if (!expectedStream) {
				const responseBody = await readBoundedProviderJson(
					response.body,
					providerControl,
					providerRequestLimits.maxResponseBytes,
					markProviderFirstByte,
				);
				if (providerControl.reason) {
					completeProvider("failed", providerControl.reason, response.status);
					finalizeUsage("conservative_settled", providerControl.reason);
					return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
				}
				if (!isRecord(responseBody)) {
					completeProvider("failed", "invalid_provider_json", response.status);
					finalizeUsage("conservative_settled", "invalid_provider_json");
					return withRateLimit(
						apiError({
							code: "invalid_llm_api_response",
							message: "The configured LLM API returned invalid JSON.",
							requestId: id,
							status: 502,
							type: "llm_api_error",
						}),
						admission.rateLimit,
					);
				}
				let normalizedResponse: ReturnType<typeof normalizeProviderJson>;
				try {
					normalizedResponse = normalizeProviderJson(responseBody, protocol, model.id);
				} catch (error) {
					if (!(error instanceof ProviderResponseValidationError)) throw error;
					completeProvider("failed", "invalid_provider_response", response.status);
					finalizeUsage("conservative_settled", "invalid_provider_response");
					return withRateLimit(
						apiError({
							code: "invalid_llm_api_response",
							message: "The configured LLM API returned an invalid response body.",
							requestId: id,
							status: 502,
							type: "llm_api_error",
						}),
						admission.rateLimit,
					);
				}
				const successfulTerminal =
					normalizedResponse.terminalType === "chat.completed" ||
					normalizedResponse.terminalType === "response.completed";
				if (successfulTerminal) {
					completeProvider("succeeded", "completed", response.status);
					finalizeUsage("settled", "completed", normalizedResponse.usage);
				} else {
					const terminalReason = `provider_terminal_${normalizedResponse.terminalType.replaceAll(".", "_")}`;
					if (normalizedResponse.usage) {
						finalizeUsage("settled", terminalReason, normalizedResponse.usage);
					} else {
						finalizeUsage("conservative_settled", terminalReason);
					}
					completeProvider("failed", terminalReason, response.status, normalizedResponse.terminalErrorCode);
				}
				return new Response(JSON.stringify(normalizedResponse.body), {
					headers: responseHeaders(response.headers, id, admission.rateLimit),
					status: response.status,
					statusText: response.statusText,
				});
			}
			const usageObserver = new ProviderUsageObserver(protocol);
			const boundedResponseBody = boundedProviderBody({
				body: response.body,
				control: providerControl,
				isEventStream: expectedStream,
				limits: providerRequestLimits,
				onChunk: markProviderFirstByte,
				onFinish: async () => undefined,
			});
			const responseBody = normalizedProviderSseBody({
				body: boundedResponseBody,
				normalizer: new ProviderSseNormalizer(protocol, model.id, markProviderFirstToken),
				onChunk: (chunk) => usageObserver.push(chunk),
				onFinish: async (result) => {
					const providerUsage = usageObserver.finish();
					const successfulTerminal =
						result.terminalType === "chat.completed" || result.terminalType === "response.completed";
					if (result.completed && successfulTerminal && providerUsage) {
						completeProvider("succeeded", "completed", response.status);
						finalizeUsage("settled", "completed", providerUsage);
					} else if (result.completed && result.terminalType && !successfulTerminal) {
						const terminalReason = `provider_terminal_${result.terminalType.replaceAll(".", "_")}`;
						if (providerUsage) {
							finalizeUsage("settled", terminalReason, providerUsage);
						} else {
							finalizeUsage("conservative_settled", terminalReason);
						}
						completeProvider("failed", terminalReason, response.status, result.terminalErrorCode);
					} else {
						const terminalReason =
							result.reason === "invalid_provider_stream" ? result.reason : (providerControl?.reason ?? result.reason);
						finalizeUsage(
							"conservative_settled",
							terminalReason ?? (result.completed ? "missing_provider_usage" : "provider_stream_failed"),
						);
						completeProvider(
							"failed",
							terminalReason ?? (result.completed ? "missing_provider_usage" : "provider_stream_failed"),
							response.status,
						);
					}
					await finishProviderPool();
					await finishAdmission();
					finishRequestLifecycle(
						c,
						protocol === "openai-completions" ? "chat_completions" : "responses",
						id,
						c.get("requestStartedAt"),
						c.get("requestStartedAtDate"),
						response.status,
					);
				},
			});
			releaseImmediately = false;
			c.set("requestCompletionDeferred", true);
			return new Response(responseBody, {
				headers: responseHeaders(response.headers, id, admission.rateLimit),
				status: response.status,
				statusText: response.statusText,
			});
		} finally {
			if (releaseImmediately) {
				if (usageReservation && !usageFinalizationScheduled) {
					finalizeUsage(
						providerRequestStarted ? "conservative_settled" : "released",
						providerRequestStarted ? "request_ended_after_provider_start" : "request_ended_before_provider",
					);
				}
				providerControl?.finish();
				await finishProviderPool();
				await finishAdmission();
			}
		}
	};

	app.post("/v1/chat/completions", (c) => forward(c, "openai-completions"));
	app.post("/v1/responses", (c) => forward(c, "openai-responses"));

	app.notFound((c) => {
		const id = c.get("requestId");
		return apiError({
			code: "not_found",
			message: "The requested endpoint does not exist.",
			requestId: id,
			status: 404,
			type: "invalid_request_error",
		});
	});

	app.onError((_error, c) => {
		const id = c.get("requestId");
		return apiError({
			code: "internal_error",
			message: "The request could not be completed.",
			requestId: id,
			status: 500,
			type: "server_error",
		});
	});

	return app;
}
