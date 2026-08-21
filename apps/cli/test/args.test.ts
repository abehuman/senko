import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.js";
import { createI18n } from "../src/i18n/index.js";

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

	it("parses supported language identifiers and aliases", () => {
		expect(parseCliArgs(["--language", "ja"]).language).toBe("ja");
		expect(parseCliArgs(["--language=zh-Hant"]).language).toBe("zh-TW");
	});

	it("localizes unsupported language errors", () => {
		expect(() => parseCliArgs(["--language", "fr"], createI18n("ja"))).toThrow("未対応の言語");
	});

	it("localizes parser errors", () => {
		const japanese = createI18n("ja");
		expect(() => parseCliArgs(["--unknown"], japanese)).toThrow("不明なオプション");
		expect(() => parseCliArgs(["--language"], japanese)).toThrow("値が必要です");
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
