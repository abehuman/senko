import { extractProviderUsage } from "./provider-usage";
import type { ApiProtocol } from "./types";
import type { ProviderUsage } from "./usage";

const MAX_PROVIDER_STRING_LENGTH = 1_000_000;

const RESPONSE_EVENT_TYPES = new Set([
	"error",
	"response.completed",
	"response.content_part.added",
	"response.content_part.done",
	"response.created",
	"response.failed",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.in_progress",
	"response.incomplete",
	"response.output_item.added",
	"response.output_item.done",
	"response.output_text.delta",
	"response.output_text.done",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_part.done",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_text.delta",
	"response.reasoning_text.done",
	"response.refusal.delta",
	"response.refusal.done",
]);

const RESPONSE_TERMINAL_EVENT_TYPES = new Set([
	"error",
	"response.completed",
	"response.failed",
	"response.incomplete",
]);

const RESPONSE_STATUSES = new Set(["completed", "failed", "in_progress", "incomplete"]);
const RESPONSE_ITEM_STATUSES = new Set(["completed", "failed", "in_progress", "incomplete"]);

export class ProviderResponseValidationError extends Error {
	constructor(message = "invalid provider response") {
		super(message);
		this.name = "ProviderResponseValidationError";
	}
}

interface NormalizedProviderJson {
	body: Record<string, unknown>;
	terminalErrorCode?: string;
	terminalType: "chat.completed" | "response.completed" | "response.failed" | "response.incomplete";
	usage?: ProviderUsage;
}

export interface NormalizedProviderStreamFinish {
	completed: boolean;
	reason?: string;
	terminalErrorCode?: string;
	terminalType?: "chat.completed" | "error" | "response.completed" | "response.failed" | "response.incomplete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
	const string = boundedString(value);
	if (string.length === 0) {
		throw new ProviderResponseValidationError();
	}
	return string;
}

function boundedString(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_PROVIDER_STRING_LENGTH) {
		throw new ProviderResponseValidationError();
	}
	return value;
}

function optionalString(value: unknown): string | null | undefined {
	if (value === undefined || value === null) {
		return value;
	}
	return boundedString(value);
}

function nonNegativeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ProviderResponseValidationError();
	}
	return value;
}

function finiteNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ProviderResponseValidationError();
	}
	return value;
}

function normalizedUsage(value: unknown, protocol: ApiProtocol): ProviderUsage {
	const usage = extractProviderUsage(value, protocol);
	if (!usage) {
		throw new ProviderResponseValidationError();
	}
	return usage;
}

function normalizeTokenDetails(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	const normalized: Record<string, unknown> = {};
	for (const field of fields) {
		if (value[field] !== undefined) {
			normalized[field] = nonNegativeInteger(value[field]);
		}
	}
	return normalized;
}

function normalizeProviderUsage(value: unknown, protocol: ApiProtocol): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	if (protocol === "openai-completions") {
		const normalized: Record<string, unknown> = {
			completion_tokens: nonNegativeInteger(value.completion_tokens),
			prompt_tokens: nonNegativeInteger(value.prompt_tokens),
			total_tokens: nonNegativeInteger(value.total_tokens),
		};
		if (value.completion_tokens_details !== undefined) {
			normalized.completion_tokens_details = normalizeTokenDetails(value.completion_tokens_details, [
				"accepted_prediction_tokens",
				"audio_tokens",
				"reasoning_tokens",
				"rejected_prediction_tokens",
			]);
		}
		if (value.prompt_tokens_details !== undefined) {
			normalized.prompt_tokens_details = normalizeTokenDetails(value.prompt_tokens_details, [
				"audio_tokens",
				"cached_tokens",
			]);
		}
		return normalized;
	}

	const normalized: Record<string, unknown> = {
		input_tokens: nonNegativeInteger(value.input_tokens),
		output_tokens: nonNegativeInteger(value.output_tokens),
		total_tokens: nonNegativeInteger(value.total_tokens),
	};
	if (value.input_tokens_details !== undefined) {
		normalized.input_tokens_details = normalizeTokenDetails(value.input_tokens_details, ["cached_tokens"]);
	}
	if (value.output_tokens_details !== undefined) {
		normalized.output_tokens_details = normalizeTokenDetails(value.output_tokens_details, ["reasoning_tokens"]);
	}
	return normalized;
}

function normalizeToolCall(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
		throw new ProviderResponseValidationError();
	}
	return {
		function: {
			arguments: boundedString(value.function.arguments),
			name: requiredString(value.function.name),
		},
		id: requiredString(value.id),
		type: "function",
	};
}

function normalizeChatMessage(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || value.role !== "assistant") {
		throw new ProviderResponseValidationError();
	}
	const message: Record<string, unknown> = {
		content: optionalString(value.content) ?? null,
		role: "assistant",
	};
	if (value.refusal !== undefined) {
		message.refusal = optionalString(value.refusal);
	}
	if (value.reasoning_content !== undefined) {
		message.reasoning_content = optionalString(value.reasoning_content);
	}
	if (value.tool_calls !== undefined) {
		if (!Array.isArray(value.tool_calls)) {
			throw new ProviderResponseValidationError();
		}
		message.tool_calls = value.tool_calls.map(normalizeToolCall);
	}
	return message;
}

function normalizeChatChoice(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	return {
		finish_reason: requiredString(value.finish_reason),
		index: nonNegativeInteger(value.index),
		message: normalizeChatMessage(value.message),
	};
}

function normalizeChatJson(value: Record<string, unknown>, resolvedModel: string): NormalizedProviderJson {
	if (value.object !== "chat.completion" || !Array.isArray(value.choices) || value.choices.length === 0) {
		throw new ProviderResponseValidationError();
	}
	requiredString(value.model);
	const usage = normalizedUsage(value, "openai-completions");
	const providerUsage = normalizeProviderUsage(value.usage, "openai-completions");
	return {
		body: {
			choices: value.choices.map(normalizeChatChoice),
			created: nonNegativeInteger(value.created),
			id: requiredString(value.id),
			model: resolvedModel,
			object: "chat.completion",
			usage: providerUsage,
		},
		terminalType: "chat.completed",
		usage,
	};
}

function normalizeResponseContent(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	if (value.type === "output_text") {
		return { text: boundedString(value.text), type: "output_text" };
	}
	if (value.type === "refusal") {
		return { refusal: boundedString(value.refusal), type: "refusal" };
	}
	throw new ProviderResponseValidationError();
}

function normalizeReasoningSummary(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || value.type !== "summary_text") {
		throw new ProviderResponseValidationError();
	}
	return { text: boundedString(value.text), type: "summary_text" };
}

function normalizeResponseItemStatus(value: unknown): string {
	const status = requiredString(value);
	if (!RESPONSE_ITEM_STATUSES.has(status)) {
		throw new ProviderResponseValidationError();
	}
	return status;
}

function normalizeResponseOutputItem(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	if (value.type === "message") {
		if (value.role !== "assistant" || !Array.isArray(value.content)) {
			throw new ProviderResponseValidationError();
		}
		return {
			content: value.content.map(normalizeResponseContent),
			id: requiredString(value.id),
			role: "assistant",
			status: normalizeResponseItemStatus(value.status),
			type: "message",
		};
	}
	if (value.type === "function_call") {
		return {
			arguments: boundedString(value.arguments),
			call_id: requiredString(value.call_id),
			id: requiredString(value.id),
			name: requiredString(value.name),
			status: normalizeResponseItemStatus(value.status),
			type: "function_call",
		};
	}
	if (value.type === "reasoning") {
		if (!Array.isArray(value.summary)) {
			throw new ProviderResponseValidationError();
		}
		const normalized: Record<string, unknown> = {
			id: requiredString(value.id),
			status: normalizeResponseItemStatus(value.status),
			summary: value.summary.map(normalizeReasoningSummary),
			type: "reasoning",
		};
		if (value.encrypted_content !== undefined) {
			normalized.encrypted_content = optionalString(value.encrypted_content);
		}
		return normalized;
	}
	throw new ProviderResponseValidationError();
}

function normalizeResponseError(value: unknown): Record<string, unknown> | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new ProviderResponseValidationError();
	return {
		code: requiredString(value.code),
		message: requiredString(value.message),
	};
}

function normalizeResponseObject(
	value: Record<string, unknown>,
	resolvedModel: string,
	expectedStatus?: string,
): Record<string, unknown> {
	if (value.object !== "response" || !Array.isArray(value.output)) {
		throw new ProviderResponseValidationError();
	}
	const status = requiredString(value.status);
	if (!RESPONSE_STATUSES.has(status) || (expectedStatus && status !== expectedStatus)) {
		throw new ProviderResponseValidationError();
	}
	requiredString(value.model);
	const normalized: Record<string, unknown> = {
		created_at: nonNegativeInteger(value.created_at),
		id: requiredString(value.id),
		model: resolvedModel,
		object: "response",
		output: value.output.map(normalizeResponseOutputItem),
		status,
	};
	if (value.completed_at !== undefined) {
		normalized.completed_at = value.completed_at === null ? null : nonNegativeInteger(value.completed_at);
	}
	if (value.error !== undefined) {
		normalized.error = normalizeResponseError(value.error);
	}
	if (value.incomplete_details !== undefined) {
		if (value.incomplete_details === null) {
			normalized.incomplete_details = null;
		} else if (isRecord(value.incomplete_details)) {
			normalized.incomplete_details = { reason: requiredString(value.incomplete_details.reason) };
		} else {
			throw new ProviderResponseValidationError();
		}
	}
	if (value.instructions !== undefined) {
		normalized.instructions = optionalString(value.instructions);
	}
	if (value.max_output_tokens !== undefined) {
		normalized.max_output_tokens =
			value.max_output_tokens === null ? null : nonNegativeInteger(value.max_output_tokens);
	}
	for (const field of ["background", "parallel_tool_calls", "store"] as const) {
		if (value[field] !== undefined) {
			if (typeof value[field] !== "boolean") throw new ProviderResponseValidationError();
			normalized[field] = value[field];
		}
	}
	if (value.previous_response_id !== undefined) {
		normalized.previous_response_id = optionalString(value.previous_response_id);
	}
	for (const field of ["temperature", "top_p"] as const) {
		if (value[field] !== undefined) {
			normalized[field] = value[field] === null ? null : finiteNumber(value[field]);
		}
	}
	if (value.truncation !== undefined) {
		normalized.truncation = requiredString(value.truncation);
	}
	if (value.usage !== undefined) {
		normalized.usage = value.usage === null ? null : normalizeProviderUsage(value.usage, "openai-responses");
	}
	return normalized;
}

function normalizeResponsesJson(value: Record<string, unknown>, resolvedModel: string): NormalizedProviderJson {
	const body = normalizeResponseObject(value, resolvedModel);
	const status = body.status;
	if (status !== "completed" && status !== "failed" && status !== "incomplete") {
		throw new ProviderResponseValidationError();
	}
	const usage = extractProviderUsage(body, "openai-responses");
	if (status === "completed" && !usage) {
		throw new ProviderResponseValidationError();
	}
	const error = isRecord(body.error) ? body.error : undefined;
	return {
		body,
		terminalErrorCode: error && typeof error.code === "string" ? error.code : undefined,
		terminalType: `response.${status}`,
		usage,
	};
}

export function normalizeProviderJson(
	value: unknown,
	protocol: ApiProtocol,
	resolvedModel: string,
): NormalizedProviderJson {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	return protocol === "openai-completions"
		? normalizeChatJson(value, resolvedModel)
		: normalizeResponsesJson(value, resolvedModel);
}

function normalizeChatDelta(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProviderResponseValidationError();
	}
	const delta: Record<string, unknown> = {};
	for (const field of ["content", "refusal", "reasoning_content", "role"] as const) {
		if (value[field] !== undefined) {
			delta[field] = optionalString(value[field]);
		}
	}
	if (value.tool_calls !== undefined) {
		if (!Array.isArray(value.tool_calls)) {
			throw new ProviderResponseValidationError();
		}
		delta.tool_calls = value.tool_calls.map((toolCall) => {
			if (!isRecord(toolCall)) throw new ProviderResponseValidationError();
			const normalized: Record<string, unknown> = { index: nonNegativeInteger(toolCall.index) };
			if (toolCall.id !== undefined) normalized.id = requiredString(toolCall.id);
			if (toolCall.type !== undefined) {
				if (toolCall.type !== "function") throw new ProviderResponseValidationError();
				normalized.type = "function";
			}
			if (toolCall.function !== undefined) {
				if (!isRecord(toolCall.function)) throw new ProviderResponseValidationError();
				const functionDelta: Record<string, unknown> = {};
				if (toolCall.function.name !== undefined) {
					functionDelta.name = boundedString(toolCall.function.name);
				}
				if (toolCall.function.arguments !== undefined) {
					functionDelta.arguments = boundedString(toolCall.function.arguments);
				}
				normalized.function = functionDelta;
			}
			return normalized;
		});
	}
	return delta;
}

function normalizeChatChunk(value: Record<string, unknown>, resolvedModel: string): Record<string, unknown> {
	if (value.object !== "chat.completion.chunk" || !Array.isArray(value.choices)) {
		throw new ProviderResponseValidationError();
	}
	const choices = value.choices.map((choice) => {
		if (!isRecord(choice)) {
			throw new ProviderResponseValidationError();
		}
		return {
			delta: normalizeChatDelta(choice.delta),
			finish_reason: optionalString(choice.finish_reason) ?? null,
			index: nonNegativeInteger(choice.index),
		};
	});
	const normalized: Record<string, unknown> = {
		choices,
		created: nonNegativeInteger(value.created),
		id: requiredString(value.id),
		model: resolvedModel,
		object: "chat.completion.chunk",
	};
	if (value.usage !== undefined) {
		if (choices.length !== 0) {
			throw new ProviderResponseValidationError();
		}
		normalized.usage = normalizeProviderUsage(value.usage, "openai-completions");
		const terminalShape = {
			choices: [{ finish_reason: "stop" }],
			object: "chat.completion",
			usage: normalized.usage,
		};
		if (!extractProviderUsage(terminalShape, "openai-completions")) {
			throw new ProviderResponseValidationError();
		}
	}
	return normalized;
}

function normalizeResponseEvent(
	value: Record<string, unknown>,
	eventName: string | undefined,
	resolvedModel: string,
): { body: Record<string, unknown>; terminal: boolean; terminalErrorCode?: string } {
	const payloadType = requiredString(value.type);
	if ((eventName && eventName !== payloadType) || !RESPONSE_EVENT_TYPES.has(payloadType)) {
		throw new ProviderResponseValidationError();
	}
	const base = {
		sequence_number: nonNegativeInteger(value.sequence_number),
		type: payloadType,
	};
	if (payloadType === "error") {
		const code = requiredString(value.code);
		return {
			body: {
				...base,
				code,
				message: requiredString(value.message),
				param: optionalString(value.param) ?? null,
			},
			terminal: true,
			terminalErrorCode: code,
		};
	}
	if (
		payloadType.startsWith("response.") &&
		["created", "in_progress", "completed", "failed", "incomplete"].includes(payloadType.slice(9))
	) {
		if (!isRecord(value.response)) throw new ProviderResponseValidationError();
		const expectedStatus = payloadType === "response.created" ? "in_progress" : payloadType.slice(9);
		const response = normalizeResponseObject(value.response, resolvedModel, expectedStatus);
		if (payloadType === "response.completed") {
			normalizedUsage({ response }, "openai-responses");
		}
		return {
			body: { ...base, response },
			terminal: RESPONSE_TERMINAL_EVENT_TYPES.has(payloadType),
			terminalErrorCode:
				payloadType === "response.failed" && isRecord(response.error) && typeof response.error.code === "string"
					? response.error.code
					: undefined,
		};
	}
	if (payloadType === "response.output_item.added" || payloadType === "response.output_item.done") {
		return {
			body: {
				...base,
				item: normalizeResponseOutputItem(value.item),
				output_index: nonNegativeInteger(value.output_index),
			},
			terminal: false,
		};
	}
	if (payloadType === "response.content_part.added" || payloadType === "response.content_part.done") {
		return {
			body: {
				...base,
				content_index: nonNegativeInteger(value.content_index),
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				part: normalizeResponseContent(value.part),
			},
			terminal: false,
		};
	}
	if (payloadType === "response.output_text.delta" || payloadType === "response.output_text.done") {
		return {
			body: {
				...base,
				content_index: nonNegativeInteger(value.content_index),
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				[payloadType.endsWith(".delta") ? "delta" : "text"]: boundedString(
					payloadType.endsWith(".delta") ? value.delta : value.text,
				),
			},
			terminal: false,
		};
	}
	if (payloadType === "response.refusal.delta" || payloadType === "response.refusal.done") {
		return {
			body: {
				...base,
				content_index: nonNegativeInteger(value.content_index),
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				[payloadType.endsWith(".delta") ? "delta" : "refusal"]: boundedString(
					payloadType.endsWith(".delta") ? value.delta : value.refusal,
				),
			},
			terminal: false,
		};
	}
	if (
		payloadType === "response.function_call_arguments.delta" ||
		payloadType === "response.function_call_arguments.done"
	) {
		return {
			body: {
				...base,
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				[payloadType.endsWith(".delta") ? "delta" : "arguments"]: boundedString(
					payloadType.endsWith(".delta") ? value.delta : value.arguments,
				),
			},
			terminal: false,
		};
	}
	if (
		payloadType === "response.reasoning_summary_part.added" ||
		payloadType === "response.reasoning_summary_part.done"
	) {
		return {
			body: {
				...base,
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				part: normalizeReasoningSummary(value.part),
				summary_index: nonNegativeInteger(value.summary_index),
			},
			terminal: false,
		};
	}
	if (
		payloadType === "response.reasoning_summary_text.delta" ||
		payloadType === "response.reasoning_summary_text.done"
	) {
		return {
			body: {
				...base,
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				summary_index: nonNegativeInteger(value.summary_index),
				[payloadType.endsWith(".delta") ? "delta" : "text"]: boundedString(
					payloadType.endsWith(".delta") ? value.delta : value.text,
				),
			},
			terminal: false,
		};
	}
	if (payloadType === "response.reasoning_text.delta" || payloadType === "response.reasoning_text.done") {
		return {
			body: {
				...base,
				content_index: nonNegativeInteger(value.content_index),
				item_id: requiredString(value.item_id),
				output_index: nonNegativeInteger(value.output_index),
				[payloadType.endsWith(".delta") ? "delta" : "text"]: boundedString(
					payloadType.endsWith(".delta") ? value.delta : value.text,
				),
			},
			terminal: false,
		};
	}
	throw new ProviderResponseValidationError();
}

export class ProviderSseNormalizer {
	private buffer = "";
	private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	private readonly encoder = new TextEncoder();
	private doneSeen = false;
	private firstOutputDeltaSeen = false;
	private terminalSeen = false;
	private terminalErrorCode: string | undefined;
	private terminalType: NormalizedProviderStreamFinish["terminalType"];
	private usageSeen = false;

	constructor(
		private readonly protocol: ApiProtocol,
		private readonly resolvedModel: string,
		private readonly onFirstOutputDelta?: () => void,
	) {}

	push(chunk: Uint8Array): Uint8Array[] {
		try {
			this.buffer += this.decoder.decode(chunk, { stream: true });
			return this.consume(false);
		} catch {
			throw new ProviderResponseValidationError();
		}
	}

	finish(): Uint8Array[] {
		try {
			this.buffer += this.decoder.decode();
			const events = this.consume(true);
			if (!this.terminalSeen || (this.protocol === "openai-completions" && !this.usageSeen)) {
				throw new ProviderResponseValidationError();
			}
			return events;
		} catch (error) {
			if (error instanceof ProviderResponseValidationError) {
				throw error;
			}
			throw new ProviderResponseValidationError();
		}
	}

	getTerminalType(): NormalizedProviderStreamFinish["terminalType"] {
		return this.terminalType;
	}

	getTerminalErrorCode(): string | undefined {
		return this.terminalErrorCode;
	}

	private consume(flush: boolean): Uint8Array[] {
		const output: Uint8Array[] = [];
		while (true) {
			const separator = /\r?\n\r?\n/.exec(this.buffer);
			if (!separator || separator.index === undefined) {
				if (flush && this.buffer.trim() !== "") {
					const event = this.buffer;
					this.buffer = "";
					const normalized = this.normalizeEvent(event);
					if (normalized) output.push(this.encoder.encode(normalized));
				}
				return output;
			}
			const event = this.buffer.slice(0, separator.index);
			this.buffer = this.buffer.slice(separator.index + separator[0].length);
			const normalized = this.normalizeEvent(event);
			if (normalized) output.push(this.encoder.encode(normalized));
		}
	}

	private normalizeEvent(event: string): string | undefined {
		const lines = event.split(/\r?\n/);
		const eventName = lines
			.find((line) => line.startsWith("event:"))
			?.slice(6)
			.trim();
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data === "") {
			return undefined;
		}
		if (data === "[DONE]") {
			if (this.doneSeen) {
				throw new ProviderResponseValidationError();
			}
			if (!this.terminalSeen && this.protocol === "openai-responses") {
				throw new ProviderResponseValidationError();
			}
			if (this.protocol === "openai-completions") {
				if (this.terminalSeen || !this.usageSeen) {
					throw new ProviderResponseValidationError();
				}
				this.terminalSeen = true;
			}
			this.doneSeen = true;
			this.terminalType = "chat.completed";
			return "data: [DONE]\n\n";
		}
		if (this.terminalSeen || this.doneSeen || (this.protocol === "openai-completions" && this.usageSeen)) {
			throw new ProviderResponseValidationError();
		}
		let value: unknown;
		try {
			value = JSON.parse(data);
		} catch {
			throw new ProviderResponseValidationError();
		}
		if (!isRecord(value)) {
			throw new ProviderResponseValidationError();
		}
		if (this.protocol === "openai-completions") {
			const normalized = normalizeChatChunk(value, this.resolvedModel);
			if (
				!this.firstOutputDeltaSeen &&
				Array.isArray(normalized.choices) &&
				normalized.choices.some(
					(choice) =>
						isRecord(choice) &&
						isRecord(choice.delta) &&
						Object.entries(choice.delta).some(
							([field, output]) =>
								field !== "role" &&
								((typeof output === "string" && output.length > 0) || (Array.isArray(output) && output.length > 0)),
						),
				)
			) {
				this.firstOutputDeltaSeen = true;
				this.onFirstOutputDelta?.();
			}
			if (normalized.usage !== undefined) {
				if (this.usageSeen) throw new ProviderResponseValidationError();
				this.usageSeen = true;
			}
			return `data: ${JSON.stringify(normalized)}\n\n`;
		}
		const normalized = normalizeResponseEvent(value, eventName, this.resolvedModel);
		if (
			!this.firstOutputDeltaSeen &&
			String(normalized.body.type).endsWith(".delta") &&
			typeof normalized.body.delta === "string" &&
			normalized.body.delta.length > 0
		) {
			this.firstOutputDeltaSeen = true;
			this.onFirstOutputDelta?.();
		}
		this.terminalSeen = normalized.terminal;
		if (normalized.terminal) {
			this.terminalType = normalized.body.type as NormalizedProviderStreamFinish["terminalType"];
			this.terminalErrorCode = normalized.terminalErrorCode;
		}
		return `event: ${String(normalized.body.type)}\ndata: ${JSON.stringify(normalized.body)}\n\n`;
	}
}

export function normalizedProviderSseBody(options: {
	body: ReadableStream<Uint8Array>;
	normalizer: ProviderSseNormalizer;
	onChunk?: (chunk: Uint8Array) => void;
	onFinish: (result: NormalizedProviderStreamFinish) => Promise<void>;
}): ReadableStream<Uint8Array> {
	const reader = options.body.getReader();
	let finished = false;
	let cancelled = false;
	const finishOnce = async (result: NormalizedProviderStreamFinish): Promise<void> => {
		if (finished) return;
		finished = true;
		await options.onFinish(result);
	};
	const finishFromCancellation = (): NormalizedProviderStreamFinish => {
		const terminalType = options.normalizer.getTerminalType();
		return terminalType
			? {
					completed: true,
					terminalErrorCode: options.normalizer.getTerminalErrorCode(),
					terminalType,
				}
			: { completed: false, reason: "client_aborted" };
	};
	return new ReadableStream<Uint8Array>({
		async cancel(reason) {
			cancelled = true;
			try {
				await reader.cancel(reason);
			} finally {
				await finishOnce(finishFromCancellation());
			}
		},
		async pull(controller) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					const chunks = done ? options.normalizer.finish() : options.normalizer.push(value);
					for (const chunk of chunks) {
						options.onChunk?.(chunk);
						controller.enqueue(chunk);
					}
					if (done) {
						controller.close();
						await finishOnce({
							completed: true,
							terminalErrorCode: options.normalizer.getTerminalErrorCode(),
							terminalType: options.normalizer.getTerminalType(),
						});
						return;
					}
					if (chunks.length > 0) return;
				}
			} catch (error) {
				if (cancelled) {
					await finishOnce(finishFromCancellation());
					return;
				}
				const invalid = error instanceof ProviderResponseValidationError;
				try {
					await reader.cancel(invalid ? "invalid_provider_stream" : "provider_stream_failed");
				} catch {
					// The transport may already be closed.
				}
				controller.error(error);
				await finishOnce({
					completed: false,
					reason: invalid ? "invalid_provider_stream" : "provider_stream_failed",
				});
			}
		},
	});
}
