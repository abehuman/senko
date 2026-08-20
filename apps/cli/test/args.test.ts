import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.js";

describe("parseCliArgs", () => {
	it("parses a prompt and endpoint overrides", () => {
		expect(
			parseCliArgs([
				"--print",
				"--base-url",
				"http://localhost:8080/v1",
				"--model",
				"swift",
				"--api",
				"openai-responses",
				"fix",
				"it",
			]),
		).toMatchObject({
			api: "openai-responses",
			baseUrl: "http://localhost:8080/v1",
			command: "run",
			model: "swift",
			print: true,
			prompt: "fix it",
		});
	});

	it("parses session commands and selectors", () => {
		expect(parseCliArgs(["sessions"]).command).toBe("sessions");
		expect(parseCliArgs(["--continue"]).continueSession).toBe(true);
		expect(parseCliArgs(["--resume", "abc123"]).resumeId).toBe("abc123");
	});

	it.each([
		[["--continue", "--resume", "abc"], "cannot be used together"],
		[["--no-session", "--continue"], "cannot be combined"],
		[["sessions", "extra"], "does not accept positional"],
		[["sessions", "--print"], "cannot be used with"],
	])("rejects invalid combinations: %j", (argv, message) => {
		expect(() => parseCliArgs(argv)).toThrow(message);
	});
});
