import { describe, expect, it, vi } from "vitest";
import {
	createAutoCompactionSettings,
	promptWithAutoCompaction,
	shouldCompactBeforePrompt,
} from "../src/auto-compact.js";

type PromptableSession = Parameters<typeof promptWithAutoCompaction>[0]["session"];

function sessionWithUsage(tokens: number | null): Pick<PromptableSession, "getContextUsage"> {
	return {
		getContextUsage: () => ({ contextWindow: 32_768, percent: null, tokens }),
	};
}

describe("automatic compaction settings", () => {
	it("reserves a maximum response plus Pi's safety margin", () => {
		expect(createAutoCompactionSettings({ contextWindow: 32_768, maxOutputTokens: 4_096 })).toEqual({
			enabled: true,
			keepRecentTokens: 20_000,
			reserveTokens: 8_192,
		});
	});

	it("leaves room for the summary in a smaller context window", () => {
		expect(createAutoCompactionSettings({ contextWindow: 16_384, maxOutputTokens: 4_096 })).toEqual({
			enabled: true,
			keepRecentTokens: 4_096,
			reserveTokens: 8_192,
		});
	});
});

describe("prompt-aware compaction", () => {
	it("includes the pending prompt when checking the safe threshold", () => {
		const config = { contextWindow: 32_768, maxOutputTokens: 4_096 };
		const prompt = "x".repeat(400);

		expect(shouldCompactBeforePrompt(sessionWithUsage(24_476), prompt, config)).toBe(false);
		expect(shouldCompactBeforePrompt(sessionWithUsage(24_477), prompt, config)).toBe(true);
		expect(shouldCompactBeforePrompt(sessionWithUsage(null), prompt, config)).toBe(false);
	});

	it("compacts without custom instructions before sending the prompt", async () => {
		const calls: string[] = [];
		const compact = vi.fn(async () => {
			calls.push("compact");
			return {
				estimatedTokensAfter: 10_000,
				firstKeptEntryId: "entry-1",
				summary: "summary",
				tokensBefore: 24_500,
			};
		});
		const prompt = vi.fn(async () => {
			calls.push("prompt");
		});
		const events: string[] = [];
		const session = {
			compact,
			getContextUsage: () => ({ contextWindow: 32_768, percent: 75, tokens: 24_500 }),
			prompt,
		} as PromptableSession;

		await expect(
			promptWithAutoCompaction({
				config: { contextWindow: 32_768, maxOutputTokens: 4_096 },
				onDisplayEvent: (event) => events.push(event.type),
				prompt: "x".repeat(1_000),
				session,
			}),
		).resolves.toEqual({ status: "prompted" });

		expect(calls).toEqual(["compact", "prompt"]);
		expect(compact).toHaveBeenCalledWith();
		expect(prompt).toHaveBeenCalledWith("x".repeat(1_000), { source: "interactive" });
		expect(events).toEqual(["auto_compaction_start", "auto_compaction_end"]);
	});

	it.each([
		{ error: new Error("Compaction cancelled"), expectedStatus: "cancelled" },
		{ error: new Error("summary endpoint failed"), expectedStatus: "compaction-error" },
	])("does not send the prompt after $expectedStatus", async ({ error, expectedStatus }) => {
		const prompt = vi.fn();
		const session = {
			compact: vi.fn(async () => {
				throw error;
			}),
			getContextUsage: () => ({ contextWindow: 32_768, percent: 75, tokens: 24_500 }),
			prompt,
		} as PromptableSession;

		const result = await promptWithAutoCompaction({
			config: { contextWindow: 32_768, maxOutputTokens: 4_096 },
			prompt: "x".repeat(1_000),
			session,
		});

		expect(result.status).toBe(expectedStatus);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("does not send a prompt that remains oversized after compaction", async () => {
		const prompt = vi.fn();
		const session = {
			compact: vi.fn(async () => ({
				estimatedTokensAfter: 24_500,
				firstKeptEntryId: "entry-1",
				summary: "summary",
				tokensBefore: 25_000,
			})),
			getContextUsage: () => ({ contextWindow: 32_768, percent: 76, tokens: 25_000 }),
			prompt,
		} as PromptableSession;

		const result = await promptWithAutoCompaction({
			config: { contextWindow: 32_768, maxOutputTokens: 4_096 },
			prompt: "x".repeat(1_000),
			session,
		});

		expect(result).toMatchObject({ status: "compaction-error" });
		expect(prompt).not.toHaveBeenCalled();
	});

	it("does not compact when the pending prompt fits", async () => {
		const compact = vi.fn();
		const prompt = vi.fn();
		const session = {
			compact,
			getContextUsage: () => ({ contextWindow: 32_768, percent: 3, tokens: 1_000 }),
			prompt,
		} as PromptableSession;

		await promptWithAutoCompaction({
			config: { contextWindow: 32_768, maxOutputTokens: 4_096 },
			prompt: "small",
			session,
		});

		expect(compact).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledOnce();
	});
});
