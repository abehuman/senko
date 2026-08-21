import { describe, expect, it } from "vitest";
import { interruptAction, slashCommandAction } from "../src/ui/input.js";

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

describe("interactive slash commands", () => {
	it("exits for /exit and its /quit alias", () => {
		expect(slashCommandAction("/exit")).toBe("exit");
		expect(slashCommandAction("  /quit  ")).toBe("exit");
	});

	it("does not treat other input as an exit command", () => {
		expect(slashCommandAction("/exit now")).toBeUndefined();
		expect(slashCommandAction("please /exit")).toBeUndefined();
		expect(slashCommandAction("/help")).toBeUndefined();
	});

	it.each(["/model", "/compact", "/new", "/clear", "/plan", "/resume"])(
		"returns the not-built placeholder for %s",
		(command) => {
			expect(slashCommandAction(command)).toBe("not-built");
			expect(slashCommandAction(`${command} example argument`)).toBe("not-built");
		},
	);
});
