import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { contentToText, projectEvent } from "../src/events.js";

function event(value: unknown): AgentSessionEvent {
	return value as AgentSessionEvent;
}

describe("TUI event projection", () => {
	it("renders streamed text, thinking, and tool lifecycle events", () => {
		expect(projectEvent(event({ type: "message_start", message: { role: "assistant" } }))).toEqual([
			{ type: "assistant_start" },
		]);
		expect(
			projectEvent(event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } })),
		).toEqual([{ type: "text_delta", text: "hello" }]);
		expect(
			projectEvent(event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } })),
		).toEqual([{ type: "thinking_delta", text: "plan" }]);
		expect(
			projectEvent(
				event({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "a.ts" } }),
			),
		).toEqual([{ id: "tool-1", label: "read a.ts", type: "tool_start" }]);
		expect(
			projectEvent(
				event({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					isError: false,
					result: [{ type: "text", text: "contents" }],
				}),
			),
		).toEqual([{ id: "tool-1", isError: false, text: "contents", type: "tool_end" }]);
		expect(
			projectEvent(
				event({
					type: "message_end",
					message: { errorMessage: "endpoint failed", role: "assistant", stopReason: "error" },
				}),
			),
		).toEqual([{ text: "endpoint failed", type: "error" }]);
	});

	it("extracts only displayable message content", () => {
		expect(
			contentToText([
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "reason" },
				{ type: "image", data: "ignored" },
			]),
		).toBe("answer\nreason");
	});
});
