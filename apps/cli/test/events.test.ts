import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { contentToText, projectEvent } from "../src/events.js";
import { createI18n } from "../src/i18n/index.js";

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

	it("renders automatic compaction while leaving manual compaction to the slash command", () => {
		expect(projectEvent(event({ type: "compaction_start", reason: "manual" }))).toEqual([]);
		expect(projectEvent(event({ type: "compaction_start", reason: "threshold" }))).toEqual([
			{
				reason: "threshold",
				text: "Auto-compacting context before the limit…",
				type: "auto_compaction_start",
			},
		]);
		expect(
			projectEvent(
				event({
					aborted: false,
					reason: "overflow",
					result: { estimatedTokensAfter: 7_200, tokensBefore: 24_100 },
					type: "compaction_end",
					willRetry: true,
				}),
			),
		).toEqual([
			{
				status: "success",
				text: "Context auto-compacted: 24,100 → ~7,200 tokens. Retrying the request.",
				type: "auto_compaction_end",
				willRetry: true,
			},
		]);
	});

	it("renders automatic compaction cancellation and errors", () => {
		expect(
			projectEvent(
				event({
					aborted: true,
					reason: "threshold",
					result: undefined,
					type: "compaction_end",
					willRetry: false,
				}),
			),
		).toEqual([
			{
				status: "cancelled",
				text: "Auto-compaction cancelled.",
				type: "auto_compaction_end",
				willRetry: false,
			},
		]);
		expect(
			projectEvent(
				event({
					aborted: false,
					errorMessage: "Auto-compaction failed: endpoint unavailable",
					reason: "threshold",
					result: undefined,
					type: "compaction_end",
					willRetry: false,
				}),
			),
		).toEqual([
			{
				status: "error",
				text: "Auto-compaction failed: endpoint unavailable",
				type: "auto_compaction_end",
				willRetry: false,
			},
		]);
	});

	it("localizes Senko-owned event fallbacks while preserving provider details", () => {
		const japanese = createI18n("ja");
		expect(projectEvent(event({ type: "compaction_start", reason: "threshold" }), japanese)[0]).toMatchObject({
			text: "上限に達する前にコンテキストを自動圧縮しています…",
		});
		expect(
			projectEvent(event({ type: "message_end", message: { role: "assistant", stopReason: "error" } }), japanese),
		).toEqual([{ text: "推論リクエストに失敗しました。", type: "error" }]);
	});
});
