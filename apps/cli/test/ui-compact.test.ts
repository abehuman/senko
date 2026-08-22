import { describe, expect, it, vi } from "vitest";
import { createI18n } from "../src/i18n/index.js";
import { compactCommandMessage, compactCurrentSession } from "../src/ui/compact.js";

describe("interactive compaction", () => {
	it("compacts without passing custom instructions", async () => {
		const compact = vi.fn().mockResolvedValue({ estimatedTokensAfter: 7_200, tokensBefore: 24_100 });

		const result = await compactCurrentSession({ compact });

		expect(compact).toHaveBeenCalledOnce();
		expect(compact).toHaveBeenCalledWith();
		expect(result).toEqual({ estimatedTokensAfter: 7_200, status: "success", tokensBefore: 24_100 });
		expect(compactCommandMessage(result)).toBe("Context compacted: 24,100 → ~7,200 tokens.");
	});

	it("reports cancellation separately from failures", async () => {
		const cancelled = await compactCurrentSession({
			compact: vi.fn().mockRejectedValue(new Error("Compaction cancelled")),
		});
		const failed = await compactCurrentSession({
			compact: vi.fn().mockRejectedValue(new Error("Nothing to compact (session too small)")),
		});

		expect(cancelled).toEqual({ status: "cancelled" });
		expect(compactCommandMessage(cancelled)).toBe("Compaction cancelled.");
		expect(failed).toEqual({ message: "Nothing to compact (session too small)", status: "error" });
		expect(compactCommandMessage(failed)).toBe("Compaction failed: Nothing to compact (session too small)");
	});

	it("formats a successful result when Pi omits its after estimate", () => {
		expect(compactCommandMessage({ status: "success", tokensBefore: 12_000 })).toBe(
			"Context compacted (12,000 tokens before).",
		);
	});

	it("localizes compaction results", () => {
		expect(
			compactCommandMessage({ estimatedTokensAfter: 7_200, status: "success", tokensBefore: 24_100 }, createI18n("ja")),
		).toBe("コンテキストを圧縮しました: 24,100 → 約7,200トークン。");
	});
});
