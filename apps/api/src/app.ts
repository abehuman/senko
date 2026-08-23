import { type Context, Hono } from "hono";
import { type AdmissionClient, durableObjectAdmissionClient } from "./admission";
import { authenticate } from "./auth";
import { readBoundedJson } from "./body";
import { getLlmApiConfig, getModelCatalog } from "./config";
import { apiError, responseHeaders } from "./http";
import type { ApiProtocol, AppEnv, LlmApiFetch, ModelDefinition } from "./types";

interface CreateAppOptions {
	admissionClient?: AdmissionClient;
	llmApiFetch?: LlmApiFetch;
}

export const MAX_OUTPUT_TOKENS_PER_REQUEST = 16_384;

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

function outputTokenParam(body: Record<string, unknown>, protocol: ApiProtocol): string | undefined {
	if (protocol === "openai-responses") {
		return "max_output_tokens";
	}
	if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) {
		return undefined;
	}
	return body.max_tokens !== undefined ? "max_tokens" : "max_completion_tokens";
}

function llmApiRequestHeaders(request: Request, apiKey: string, id: string): Headers {
	const headers = new Headers({
		accept: request.headers.get("accept") ?? "application/json",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
		"x-request-id": id,
	});
	for (const name of ["openai-organization", "openai-project"]) {
		const value = request.headers.get(name);
		if (value) {
			headers.set(name, value);
		}
	}
	return headers;
}

function releaseAfterBody(body: ReadableStream<Uint8Array>, release: () => Promise<void>): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let released = false;
	const releaseOnce = async (): Promise<void> => {
		if (released) {
			return;
		}
		released = true;
		try {
			await release();
		} catch {
			// Admission leases expire automatically; response streaming must not fail if release is temporarily unavailable.
		}
	};

	return new ReadableStream<Uint8Array>({
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				await releaseOnce();
			}
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					await releaseOnce();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				controller.error(error);
				await releaseOnce();
			}
		},
	});
}

async function compatibleLlmApiError(response: Response, id: string): Promise<Response> {
	const headers = responseHeaders(response.headers, id);
	const safeClientError = [400, 408, 409, 413, 422, 429].includes(response.status);
	if (safeClientError && response.headers.get("content-type")?.includes("application/json")) {
		try {
			const body: unknown = await response.json();
			if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
				return new Response(JSON.stringify(body), { headers, status: response.status });
			}
		} catch {
			// Normalize malformed LLM API errors below without exposing their body.
		}
	}
	const error = apiError({
		code: "llm_api_error",
		message: "The configured LLM API rejected the request.",
		requestId: id,
		status: safeClientError ? response.status : 502,
		type: "llm_api_error",
	});
	for (const [name, value] of headers) {
		if (name !== "content-type") {
			error.headers.set(name, value);
		}
	}
	return error;
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const admissionClient = options.admissionClient ?? durableObjectAdmissionClient;
	const callLlmApi = options.llmApiFetch ?? fetch;

	app.use("*", async (c, next) => {
		const id = requestId();
		c.set("requestId", id);
		await next();
		c.res.headers.set("x-request-id", id);
	});

	app.get("/", (c) => c.json({ name: "Senko API", status: "ok" }));
	app.get("/health", (c) => c.json({ status: "ok" }));

	app.use("/v1/*", async (c, next) => {
		const id = c.get("requestId");
		if (!c.env.SENKO_API_KEYS?.trim()) {
			return apiError({
				code: "configuration_error",
				message: "Set the SENKO_API_KEYS Worker secret before serving authenticated API requests.",
				requestId: id,
				status: 503,
				type: "server_error",
			});
		}
		const apiKey = await authenticate(c.req.header("authorization"), c.env.SENKO_API_KEYS);
		if (!apiKey) {
			return apiError({
				code: "invalid_api_key",
				message: "Invalid authentication credentials.",
				requestId: id,
				status: 401,
				type: "authentication_error",
			});
		}
		c.set("apiKeyId", apiKey.id);
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
		const admission = await admissionClient.acquire(c.env, c.get("apiKeyId"), id);
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
			if (!configurationError && !unavailable) {
				response.headers.set("retry-after", String(admission.retryAfterSeconds));
			}
			return response;
		}

		let releaseImmediately = true;
		try {
			const parsedBody = await readBoundedJson(c.req.raw);
			if (!parsedBody.ok) {
				return apiError({
					code: parsedBody.reason,
					message:
						parsedBody.reason === "request_too_large"
							? "The request body exceeds the 1 MiB limit."
							: "The request body must be valid JSON.",
					param: null,
					requestId: id,
					status: parsedBody.reason === "request_too_large" ? 413 : 400,
					type: "invalid_request_error",
				});
			}
			const body = parsedBody.value;
			if (!isRecord(body) || typeof body.model !== "string" || body.model.trim() === "") {
				return apiError({
					code: "invalid_model",
					message: "The model field must be a non-empty string.",
					param: "model",
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
			}

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
			const requestedModel = body.model.trim();
			const model = requestedModel === "fast" ? catalog.value.fast : catalog.value.byId.get(requestedModel);
			if (!model || !model.supported_protocols.includes(protocol)) {
				return apiError({
					code: "invalid_model",
					message: `Model "${requestedModel}" is not available for this API protocol.`,
					param: "model",
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
			}
			const tokenParam = outputTokenParam(body, protocol);
			if (!tokenParam) {
				return apiError({
					code: "invalid_max_output_tokens",
					message: "Set only one of max_completion_tokens or max_tokens.",
					param: "max_completion_tokens",
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
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
				return apiError({
					code: "invalid_max_output_tokens",
					message: `${tokenParam} must be a positive integer no greater than ${maxOutputTokens}.`,
					param: tokenParam,
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
			}
			if (protocol === "openai-completions" && body.n !== undefined && body.n !== 1) {
				return apiError({
					code: "unsupported_choice_count",
					message: "Senko supports exactly one Chat Completions choice per request.",
					param: "n",
					requestId: id,
					status: 400,
					type: "invalid_request_error",
				});
			}

			const llmApi = getLlmApiConfig(c.env);
			if (!llmApi.ok) {
				return apiError({
					code: "configuration_error",
					message: llmApi.message,
					requestId: id,
					status: 503,
					type: "server_error",
				});
			}

			const llmApiBody = JSON.stringify({
				...body,
				...(protocol === "openai-completions" ? { n: 1 } : {}),
				[tokenParam]: requestedOutputTokens ?? maxOutputTokens,
				model: model.id,
			});
			const llmApiUrl = `${llmApi.value.baseUrl}${pathForProtocol(protocol)}`;
			let response: Response;
			try {
				response = await callLlmApi(llmApiUrl, {
					body: llmApiBody,
					headers: llmApiRequestHeaders(c.req.raw, llmApi.value.apiKey, id),
					method: "POST",
					signal: c.req.raw.signal,
				});
			} catch {
				return apiError({
					code: "llm_api_unavailable",
					message: "The configured LLM API is temporarily unavailable.",
					requestId: id,
					status: 502,
					type: "llm_api_error",
				});
			}
			if (!response.ok) {
				return compatibleLlmApiError(response, id);
			}
			if (!response.body) {
				return new Response(null, {
					headers: responseHeaders(response.headers, id),
					status: response.status,
					statusText: response.statusText,
				});
			}
			const responseBody = releaseAfterBody(response.body, () => admissionClient.release(c.env, admission.leaseId));
			releaseImmediately = false;
			return new Response(responseBody, {
				headers: responseHeaders(response.headers, id),
				status: response.status,
				statusText: response.statusText,
			});
		} finally {
			if (releaseImmediately) {
				await admissionClient.release(c.env, admission.leaseId);
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
