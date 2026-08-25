import type { ApiProtocol } from "./types";
import type { ProviderUsage } from "./usage";

const MAX_REPORTED_TOKENS = 1_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportedTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REPORTED_TOKENS
		? value
		: undefined;
}

function terminalResponse(value: Record<string, unknown>): Record<string, unknown> | undefined {
	const response = isRecord(value.response) ? value.response : value;
	return response.object === "response" &&
		(response.status === "completed" || response.status === "failed" || response.status === "incomplete")
		? response
		: undefined;
}

function responseUsage(value: Record<string, unknown>): ProviderUsage | undefined {
	const usage = value.usage;
	if (!isRecord(usage)) return undefined;
	const inputTokens = reportedTokens(usage.input_tokens);
	const outputTokens = reportedTokens(usage.output_tokens);
	return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens };
}

function completedChatCompletion(value: Record<string, unknown>): boolean {
	return (
		value.object === "chat.completion" &&
		Array.isArray(value.choices) &&
		value.choices.length > 0 &&
		value.choices.every(
			(choice) => isRecord(choice) && typeof choice.finish_reason === "string" && choice.finish_reason.length > 0,
		)
	);
}

export function extractProviderUsage(value: unknown, protocol: ApiProtocol): ProviderUsage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const terminal =
		protocol === "openai-responses" ? terminalResponse(value) : completedChatCompletion(value) ? value : undefined;
	if (protocol === "openai-responses") return terminal ? responseUsage(terminal) : undefined;
	const usage = terminal?.usage;
	if (!isRecord(usage)) return undefined;
	const inputTokens = reportedTokens(usage.prompt_tokens);
	const outputTokens = reportedTokens(usage.completion_tokens);
	return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens };
}

export class ProviderUsageObserver {
	private buffer = "";
	private readonly decoder = new TextDecoder();
	private invalid = false;
	private terminalSeen = false;
	private doneSeen = false;
	private terminalUsage: ProviderUsage | undefined;

	constructor(private readonly protocol: ApiProtocol) {}

	push(chunk: Uint8Array): void {
		this.buffer += this.decoder.decode(chunk, { stream: true });
		this.consumeEvents(false);
	}

	finish(): ProviderUsage | undefined {
		this.buffer += this.decoder.decode();
		this.consumeEvents(true);
		if (this.invalid || !this.terminalSeen || !this.terminalUsage) {
			return undefined;
		}
		return this.protocol === "openai-completions" && !this.doneSeen ? undefined : this.terminalUsage;
	}

	private consumeEvents(flush: boolean): void {
		while (true) {
			const separator = /\r?\n\r?\n/.exec(this.buffer);
			if (!separator || separator.index === undefined) {
				if (flush && this.buffer.trim() !== "") {
					this.consumeEvent(this.buffer);
					this.buffer = "";
				}
				return;
			}
			const event = this.buffer.slice(0, separator.index);
			this.buffer = this.buffer.slice(separator.index + separator[0].length);
			this.consumeEvent(event);
		}
	}

	private consumeEvent(event: string): void {
		const lines = event.split(/\r?\n/);
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data === "") {
			return;
		}
		if (data === "[DONE]") {
			if (this.doneSeen || !this.terminalSeen) {
				this.invalid = true;
				return;
			}
			this.doneSeen = true;
			return;
		}
		if (this.terminalSeen || this.doneSeen) {
			this.invalid = true;
			return;
		}
		try {
			const value: unknown = JSON.parse(data);
			if (!isRecord(value)) {
				this.invalid = true;
				return;
			}
			if (this.protocol === "openai-responses") {
				const eventName = lines
					.find((line) => line.startsWith("event:"))
					?.slice(6)
					.trim();
				const payloadType = typeof value.type === "string" ? value.type : undefined;
				if (eventName && payloadType && eventName !== payloadType) {
					this.invalid = true;
					return;
				}
				const terminalType = eventName ?? payloadType;
				if (
					terminalType !== "response.completed" &&
					terminalType !== "response.failed" &&
					terminalType !== "response.incomplete"
				) {
					return;
				}
				if (!isRecord(value.response)) {
					this.invalid = true;
					return;
				}
				this.terminalSeen = true;
				this.terminalUsage = responseUsage(value.response);
				if (terminalType === "response.completed" && !this.terminalUsage) this.invalid = true;
				return;
			}

			if (isRecord(value.usage)) {
				const usageValue = value.usage;
				const usage =
					value.object === "chat.completion.chunk" && Array.isArray(value.choices) && value.choices.length === 0
						? (() => {
								const inputTokens = reportedTokens(usageValue.prompt_tokens);
								const outputTokens = reportedTokens(usageValue.completion_tokens);
								return inputTokens === undefined || outputTokens === undefined
									? undefined
									: { inputTokens, outputTokens };
							})()
						: undefined;
				if (!usage) {
					this.invalid = true;
					return;
				}
				this.terminalSeen = true;
				this.terminalUsage = usage;
			}
		} catch {
			this.invalid = true;
		}
	}
}
