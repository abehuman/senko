import { describe, expect, it } from "vitest";
import { idleFooter } from "../src/ui/footer.js";

describe("interactive footer", () => {
	it("shows only the model and working directory while idle", () => {
		expect(idleFooter("google/gemini-3.7-flash", "/workspace/senko")).toBe(
			"google/gemini-3.7-flash · /workspace/senko",
		);
	});
});
