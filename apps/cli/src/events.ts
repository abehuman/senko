import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type DisplayEvent =
	| { type: "assistant_start" }
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_start"; id: string; label: string }
	| { type: "tool_update"; id: string; text: string }
	| { type: "tool_end"; id: string; isError: boolean; text: string }
	| { type: "error"; text: string };

export function contentToText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (!Array.isArray(value)) {
		return "";
	}
	return value
		.map((item) => {
			if (typeof item !== "object" || item === null) {
				return "";
			}
			const record = item as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") {
				return record.text;
			}
			if (record.type === "thinking" && typeof record.thinking === "string") {
				return record.thinking;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function compact(value: unknown, maxLength = 600): string {
	const text = contentToText(value) || (typeof value === "string" ? value : safeJson(value));
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function summarizeArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) {
		return compact(args, 160);
	}
	const record = args as Record<string, unknown>;
	for (const key of ["path", "command", "query", "pattern"]) {
		if (typeof record[key] === "string") {
			return compact(record[key], 160);
		}
	}
	return compact(args, 160);
}

export function projectEvent(event: AgentSessionEvent): DisplayEvent[] {
	switch (event.type) {
		case "message_start":
			return event.message.role === "assistant" ? [{ type: "assistant_start" }] : [];
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				return [{ type: "text_delta", text: update.delta }];
			}
			if (update.type === "thinking_delta") {
				return [{ type: "thinking_delta", text: update.delta }];
			}
			if (update.type === "error") {
				return [{ type: "error", text: update.error.errorMessage ?? "Inference request failed." }];
			}
			return [];
		}
		case "message_end":
			if (event.message.role === "assistant" && event.message.stopReason === "error") {
				return [{ type: "error", text: event.message.errorMessage ?? "Inference request failed." }];
			}
			return [];
		case "tool_execution_start": {
			const detail = summarizeArgs(event.args);
			return [
				{
					id: event.toolCallId,
					label: detail ? `${event.toolName} ${detail}` : event.toolName,
					type: "tool_start",
				},
			];
		}
		case "tool_execution_update":
			return [{ id: event.toolCallId, text: compact(event.partialResult), type: "tool_update" }];
		case "tool_execution_end":
			return [
				{
					id: event.toolCallId,
					isError: event.isError,
					text: compact(event.result),
					type: "tool_end",
				},
			];
		default:
			return [];
	}
}
