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
import { getAuthenticationMode, getLlmApiConfig, getModelCatalog } from "./config";
import type { ApiKeyScope } from "./db/schema";
import { apiError, applyRateLimitHeaders, responseHeaders } from "./http";
import { type ApiKeyRecord, type IdentityResult, type IdentityService, postgresIdentityService } from "./identity";
import { parseCreateAccountRequest, parseIssueApiKeyRequest, validUuid } from "./management";
import {
	boundedProviderBody,
	createProviderRequestControl,
	DEFAULT_PROVIDER_REQUEST_LIMITS,
	type ProviderAbortReason,
	type ProviderRequestControl,
	type ProviderRequestLimits,
	readBoundedProviderJson,
} from "./provider-stream";
import { normalizeLlmApiRequest } from "./request-policy";
import type { ApiProtocol, AppEnv, LlmApiFetch, ModelDefinition } from "./types";

interface CreateAppOptions {
	admissionClient?: AdmissionClient;
	identityService?: IdentityService;
	llmApiFetch?: LlmApiFetch;
	providerRequestLimits?: Partial<ProviderRequestLimits>;
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

function identityFailureResponse<T>(result: Extract<IdentityResult<T>, { ok: false }>, requestId: string): Response {
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
		console.warn(JSON.stringify({ event: "identity_database_unavailable", request_id: requestId }));
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
				? "The account or team is not active."
				: "The requested account, team, or API key does not exist.",
		requestId,
		status: result.reason === "conflict" ? 409 : 404,
		type: "invalid_request_error",
	});
}

function apiKeyResponse(key: ApiKeyRecord): Record<string, unknown> {
	return {
		account_id: key.accountId,
		created_at: key.createdAt,
		expires_at: key.expiresAt,
		id: key.id,
		key_prefix: key.keyPrefix,
		name: key.name,
		object: "api_key",
		public_id: key.publicId,
		scopes: key.scopes,
		status: key.status,
		team_id: key.teamId,
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

function logAdmissionFailure(event: "admission_release_failed" | "admission_renew_failed", requestId: string): void {
	console.warn(JSON.stringify({ event, request_id: requestId }));
}

function startAdmissionHeartbeat(options: {
	admissionClient: AdmissionClient;
	env: AppEnv["Bindings"];
	leaseExpiresAt: number;
	leaseId: string;
	onLost: () => void;
	requestId: string;
}): { stop(): void } {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let leaseExpiresAt = options.leaseExpiresAt;
	const loseLease = (): void => {
		stopped = true;
		logAdmissionFailure("admission_renew_failed", options.requestId);
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
	const identityService = options.identityService ?? postgresIdentityService;
	const callLlmApi = options.llmApiFetch ?? fetch;
	const providerRequestLimits: ProviderRequestLimits = {
		...DEFAULT_PROVIDER_REQUEST_LIMITS,
		...options.providerRequestLimits,
	};

	app.use("*", async (c, next) => {
		const id = requestId();
		c.set("requestId", id);
		await next();
		c.res.headers.set("x-request-id", id);
	});

	app.get("/", (c) => c.json({ name: "Senko API", status: "ok" }));
	app.get("/health", (c) => c.json({ status: "ok" }));

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
			return identityFailureResponse(created, id);
		}
		return c.json(
			{
				created_at: created.value.createdAt,
				id: created.value.id,
				name: created.value.name,
				object: "account",
				plan_key: created.value.planKey,
				status: created.value.status,
			},
			201,
			noStoreHeaders(),
		);
	});

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
			return identityFailureResponse(issued, id);
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
			return identityFailureResponse(revoked, id);
		}
		return c.json(apiKeyResponse(revoked.value), 200, noStoreHeaders());
	});

	app.use("/v1/*", async (c, next) => {
		const id = c.get("requestId");
		const mode = getAuthenticationMode(c.env);
		if (!mode.ok) {
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
				if (databaseKey.reason === "configuration_error" || databaseKey.reason === "unavailable") {
					return identityFailureResponse(databaseKey, id);
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
					console.warn(JSON.stringify({ event: "api_key_last_used_update_failed", request_id: id }));
				}
			});
			try {
				c.executionCtx.waitUntil(touch);
			} catch {
				void touch;
			}
		}

		const requiredScope = REQUIRED_SCOPES.get(`${c.req.method} ${c.req.path}`);
		if (requiredScope && !scopes.includes(requiredScope)) {
			return apiError({
				code: "insufficient_scope",
				message: `The API key does not grant the required ${requiredScope} scope.`,
				requestId: id,
				status: 403,
				type: "permission_error",
			});
		}
		c.set("apiKeyId", apiKeyId);
		c.set("apiKeyScopes", scopes);
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
		const deadlineAt = Date.now() + providerRequestLimits.totalTimeoutMs;
		const keyId = c.get("apiKeyId");
		const accountId = c.get("accountId") ?? keyId;
		const admission = await admissionClient.acquire(c.env, accountId, keyId, id, deadlineAt);
		if (!admission.ok) {
			const configurationError = admission.reason === "configuration_error";
			const unavailable = admission.reason === "admission_unavailable";
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
			if ("rateLimit" in admission) {
				response.headers.set("retry-after", String(admission.retryAfterSeconds));
				applyRateLimitHeaders(response.headers, admission.rateLimit);
			}
			return response;
		}

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
				logAdmissionFailure("admission_release_failed", id);
			}
		};
		const heartbeat = startAdmissionHeartbeat({
			admissionClient,
			env: c.env,
			leaseExpiresAt: admission.leaseExpiresAt,
			leaseId: admission.leaseId,
			onLost: () => {
				leaseLost = true;
				providerControl?.abort("admission_lost");
			},
			requestId: id,
		});
		let releaseImmediately = true;
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

			const llmApi = getLlmApiConfig(c.env);
			if (!llmApi.ok) {
				return withRateLimit(
					apiError({
						code: "configuration_error",
						message: llmApi.message,
						requestId: id,
						status: 503,
						type: "server_error",
					}),
					admission.rateLimit,
				);
			}

			providerControl = createProviderRequestControl(c.req.raw.signal, deadlineAt, providerRequestLimits);
			if (leaseLost) {
				providerControl.abort("admission_lost");
				return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
			}
			const llmApiBody = JSON.stringify(normalizedRequest.value);
			const llmApiUrl = `${llmApi.value.baseUrl}${pathForProtocol(protocol)}`;
			let response: Response;
			try {
				response = await callLlmApi(llmApiUrl, {
					body: llmApiBody,
					headers: llmApiRequestHeaders(llmApi.value.apiKey, id, body.stream === true),
					method: "POST",
					signal: providerControl.signal,
				});
			} catch {
				return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
			}
			providerControl.markResponseStarted();
			if (!response.ok) {
				const jsonError = response.headers.get("content-type")?.includes("application/json") === true;
				const errorBody = jsonError ? await readBoundedProviderJson(response.body, providerControl) : undefined;
				if (!jsonError) {
					await response.body?.cancel("non-JSON provider error");
				}
				if (providerControl.reason) {
					return providerFailureResponse(providerControl.reason, id, admission.rateLimit);
				}
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
				return new Response(null, {
					headers: responseHeaders(response.headers, id, admission.rateLimit),
					status: response.status,
					statusText: response.statusText,
				});
			}
			const responseBody = boundedProviderBody({
				body: response.body,
				control: providerControl,
				isEventStream: expectedStream,
				limits: providerRequestLimits,
				onFinish: finishAdmission,
			});
			releaseImmediately = false;
			return new Response(responseBody, {
				headers: responseHeaders(response.headers, id, admission.rateLimit),
				status: response.status,
				statusText: response.statusText,
			});
		} finally {
			if (releaseImmediately) {
				providerControl?.finish();
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
