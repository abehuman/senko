import { describe, expect, it } from "vitest";
import { interruptAction } from "../src/ui/input.js";

describe("interactive cancellation", () => {
	it("aborts active work with Escape or Ctrl+C", () => {
		expect(interruptAction("\x1b", true)).toBe("abort");
		expect(interruptAction("\x03", true)).toBe("abort");
	});

	it("exits on idle Ctrl+C and ignores idle Escape", () => {
		expect(interruptAction("\x03", false)).toBe("exit");
		expect(interruptAction("\x1b", false)).toBeUndefined();
		expect(interruptAction("x", false)).toBeUndefined();
	});
});
