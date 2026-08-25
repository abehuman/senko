import type { ApiProtocol, ModelDefinition } from "./types";

export const CHAT_REQUEST_FIELDS = [
	"frequency_penalty",
	"max_completion_tokens",
	"max_tokens",
	"messages",
	"model",
	"n",
	"parallel_tool_calls",
	"presence_penalty",
	"prompt_cache_key",
	"reasoning_effort",
	"response_format",
	"seed",
	"stop",
	"store",
	"stream",
	"stream_options",
	"temperature",
	"tool_choice",
	"tools",
	"top_p",
	"verbosity",
] as const;

export const RESPONSES_REQUEST_FIELDS = [
	"background",
	"include",
	"input",
	"instructions",
	"max_output_tokens",
	"model",
	"parallel_tool_calls",
	"prompt_cache_key",
	"reasoning",
	"store",
	"stream",
	"temperature",
	"text",
	"tool_choice",
	"tools",
	"top_p",
	"truncation",
] as const;

const CHAT_ALLOWED_FIELDS = new Set<string>(CHAT_REQUEST_FIELDS);
const RESPONSES_ALLOWED_FIELDS = new Set<string>(RESPONSES_REQUEST_FIELDS);

const FORBIDDEN_FIELDS: Record<string, string> = {
	conversation: "Provider-side conversations are not supported.",
	metadata: "Client-controlled provider metadata is not supported.",
	previous_response_id: "Provider-side response continuation is not supported.",
	prompt_cache_retention: "Client-controlled provider cache retention is not supported.",
	service_tier: "Client-controlled provider service tiers are not supported.",
};

const RESPONSE_INCLUDE_VALUES = new Set(["reasoning.encrypted_content"]);

export interface RequestPolicyError {
	code: string;
	message: string;
	param: string;
}

export type RequestPolicyResult =
	| { ok: true; value: Record<string, unknown> }
	| { error: RequestPolicyError; ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: string, message: string, param: string): RequestPolicyResult {
	return { error: { code, message, param }, ok: false };
}

function validateAllowedFields(body: Record<string, unknown>, protocol: ApiProtocol): RequestPolicyResult | undefined {
	const allowed = protocol === "openai-completions" ? CHAT_ALLOWED_FIELDS : RESPONSES_ALLOWED_FIELDS;
	for (const field of Object.keys(body)) {
		const forbiddenMessage = FORBIDDEN_FIELDS[field];
		if (forbiddenMessage) {
			return error("unsupported_parameter", forbiddenMessage, field);
		}
		if (!allowed.has(field)) {
			return error("unsupported_parameter", `The ${field} parameter is not supported by Senko.`, field);
		}
	}
	return undefined;
}

function validateBoolean(body: Record<string, unknown>, field: string): RequestPolicyResult | undefined {
	if (body[field] !== undefined && typeof body[field] !== "boolean") {
		return error("invalid_parameter", `${field} must be a boolean.`, field);
	}
	return undefined;
}

function validateFiniteNumber(body: Record<string, unknown>, field: string): RequestPolicyResult | undefined {
	const value = body[field];
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
		return error("invalid_parameter", `${field} must be a finite number.`, field);
	}
	return undefined;
}

function validateProviderState(body: Record<string, unknown>, protocol: ApiProtocol): RequestPolicyResult | undefined {
	if (body.store !== undefined && body.store !== false) {
		return error("unsupported_provider_storage", "Provider-side response storage is disabled by Senko.", "store");
	}
	if (protocol === "openai-responses" && body.background !== undefined && body.background !== false) {
		return error("unsupported_background_request", "Background provider requests are not supported.", "background");
	}
	return undefined;
}

function validateTools(value: unknown): RequestPolicyResult | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return error("invalid_tools", "tools must be an array of function tool definitions.", "tools");
	}
	for (const tool of value) {
		if (!isRecord(tool) || tool.type !== "function") {
			return error("unsupported_tool", "Senko supports client-defined function tools only.", "tools");
		}
	}
	return undefined;
}

function validateToolChoice(value: unknown): RequestPolicyResult | undefined {
	if (value === undefined || typeof value === "string") {
		return undefined;
	}
	if (!isRecord(value) || value.type !== "function") {
		return error("unsupported_tool_choice", "Senko supports function tool choices only.", "tool_choice");
	}
	return undefined;
}

function validateInputContent(value: unknown, model: ModelDefinition): RequestPolicyResult | undefined {
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const current = stack.pop();
		if (Array.isArray(current)) {
			stack.push(...current);
			continue;
		}
		if (!isRecord(current)) {
			continue;
		}
		if (current.type === "input_file" || current.type === "file" || typeof current.file_id === "string") {
			return error("unsupported_file_input", "Provider-hosted file inputs are not supported.", "input");
		}
		if (
			(current.type === "image_url" || current.type === "input_image" || current.type === "image") &&
			!model.input_modalities.includes("image")
		) {
			return error("unsupported_input_modality", `Model "${model.id}" does not support image input.`, "input");
		}
		if ((current.type === "input_audio" || current.type === "audio") && !model.input_modalities.includes("audio")) {
			return error("unsupported_input_modality", `Model "${model.id}" does not support audio input.`, "input");
		}
		stack.push(...Object.values(current));
	}
	return undefined;
}

function validateStreamOptions(body: Record<string, unknown>): RequestPolicyResult | undefined {
	const streamOptions = body.stream_options;
	if (streamOptions === undefined) {
		return undefined;
	}
	if (!isRecord(streamOptions) || Object.keys(streamOptions).some((key) => key !== "include_usage")) {
		return error("unsupported_parameter", "stream_options supports only the include_usage option.", "stream_options");
	}
	if (streamOptions.include_usage !== undefined && typeof streamOptions.include_usage !== "boolean") {
		return error("invalid_parameter", "stream_options.include_usage must be a boolean.", "stream_options");
	}
	return undefined;
}

function validateResponseInclude(body: Record<string, unknown>): RequestPolicyResult | undefined {
	if (body.include === undefined) {
		return undefined;
	}
	if (
		!Array.isArray(body.include) ||
		body.include.some((value) => typeof value !== "string" || !RESPONSE_INCLUDE_VALUES.has(value))
	) {
		return error("unsupported_parameter", "include supports only reasoning.encrypted_content.", "include");
	}
	return undefined;
}

function validateProtocolShape(
	body: Record<string, unknown>,
	protocol: ApiProtocol,
	model: ModelDefinition,
): RequestPolicyResult | undefined {
	const streamError = validateBoolean(body, "stream");
	if (streamError) {
		return streamError;
	}
	const parallelToolsError = validateBoolean(body, "parallel_tool_calls");
	if (parallelToolsError) {
		return parallelToolsError;
	}
	for (const field of ["frequency_penalty", "presence_penalty", "temperature", "top_p"]) {
		const numberError = validateFiniteNumber(body, field);
		if (numberError) {
			return numberError;
		}
	}
	const toolsError = validateTools(body.tools);
	if (toolsError) {
		return toolsError;
	}
	const toolChoiceError = validateToolChoice(body.tool_choice);
	if (toolChoiceError) {
		return toolChoiceError;
	}

	if (protocol === "openai-completions") {
		if (!Array.isArray(body.messages)) {
			return error("invalid_messages", "messages must be an array.", "messages");
		}
		const streamOptionsError = validateStreamOptions(body);
		if (streamOptionsError) {
			return streamOptionsError;
		}
		return validateInputContent(body.messages, model);
	}

	if (typeof body.input !== "string" && !Array.isArray(body.input)) {
		return error("invalid_input", "input must be a string or an array.", "input");
	}
	const includeError = validateResponseInclude(body);
	if (includeError) {
		return includeError;
	}
	return validateInputContent(body.input, model);
}

function copyAllowedFields(body: Record<string, unknown>, protocol: ApiProtocol): Record<string, unknown> {
	const allowed = protocol === "openai-completions" ? CHAT_ALLOWED_FIELDS : RESPONSES_ALLOWED_FIELDS;
	const normalized: Record<string, unknown> = {};
	for (const field of allowed) {
		if (body[field] !== undefined && field !== "background" && field !== "stream_options") {
			normalized[field] = body[field];
		}
	}
	if (body.stream === true && protocol === "openai-completions") {
		normalized.stream_options = { include_usage: true };
	}
	normalized.store = false;
	return normalized;
}

export function normalizeLlmApiRequest(options: {
	body: Record<string, unknown>;
	maxOutputTokens: number;
	model: ModelDefinition;
	protocol: ApiProtocol;
	tokenParam: "max_completion_tokens" | "max_output_tokens" | "max_tokens";
}): RequestPolicyResult {
	const fieldsError = validateAllowedFields(options.body, options.protocol);
	if (fieldsError) {
		return fieldsError;
	}
	const stateError = validateProviderState(options.body, options.protocol);
	if (stateError) {
		return stateError;
	}
	const shapeError = validateProtocolShape(options.body, options.protocol, options.model);
	if (shapeError) {
		return shapeError;
	}

	const normalized = copyAllowedFields(options.body, options.protocol);
	normalized.model = options.model.id;
	normalized[options.tokenParam] = options.body[options.tokenParam] ?? options.maxOutputTokens;
	if (options.protocol === "openai-completions") {
		normalized.n = 1;
	}
	return { ok: true, value: normalized };
}
