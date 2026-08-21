import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n/index.js";
import { createSlashCommands, interruptAction, slashCommandAction, slashCommands } from "../src/ui/input.js";

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
	it("suggests slash commands and prioritizes /compact for /c", async () => {
		const provider = new CombinedAutocompleteProvider(slashCommands, process.cwd());
		const suggestions = await provider.getSuggestions(["/c"], 0, 2, { signal: new AbortController().signal });

		expect(suggestions?.items.map((item) => item.value)).toEqual(["compact", "clear"]);
		const compact = suggestions?.items[0];
		if (!suggestions || !compact) throw new Error("Expected /compact suggestion");
		expect(provider.applyCompletion(["/c"], 0, 2, compact, suggestions.prefix)).toMatchObject({
			cursorCol: 9,
			lines: ["/compact "],
		});
	});

	it("lists every documented command when the user types slash", async () => {
		const provider = new CombinedAutocompleteProvider(slashCommands, process.cwd());
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"compact",
			"clear",
			"new",
			"resume",
			"model",
			"plan",
			"exit",
			"quit",
		]);
	});

	it("localizes descriptions without changing command names or priority", () => {
		const commands = createSlashCommands(createI18n("ja"));
		expect(commands.slice(0, 2)).toEqual([
			{ name: "compact", description: "現在のセッションのコンテキストを圧縮" },
			{ name: "clear", description: "新しいセッションを開始" },
		]);
	});

	it("exits for /exit and its /quit alias", () => {
		expect(slashCommandAction("/exit")).toBe("exit");
		expect(slashCommandAction("  /quit  ")).toBe("exit");
	});

	it("does not treat other input as an exit command", () => {
		expect(slashCommandAction("/exit now")).toBeUndefined();
		expect(slashCommandAction("please /exit")).toBeUndefined();
		expect(slashCommandAction("/help")).toBeUndefined();
	});

	it("runs /compact without accepting custom instructions", () => {
		expect(slashCommandAction("/compact")).toBe("compact");
		expect(slashCommandAction("  /compact  ")).toBe("compact");
		expect(slashCommandAction("/compact focus on tools")).toBe("compact-usage");
	});

	it("starts a new session for /clear and its /new alias", () => {
		expect(slashCommandAction("/clear")).toBe("new-session");
		expect(slashCommandAction("  /new  ")).toBe("new-session");
	});

	it("does not accept arguments for /clear or /new", () => {
		expect(slashCommandAction("/clear release prep")).toBe("new-session-usage");
		expect(slashCommandAction("/new release prep")).toBe("new-session-usage");
	});

	it("opens the session picker for /resume", () => {
		expect(slashCommandAction("/resume")).toBe("resume");
	});

	it("does not accept arguments for /resume", () => {
		expect(slashCommandAction("/resume session-id")).toBe("resume-usage");
	});

	it.each(["/model", "/plan"])("returns the not-built placeholder for %s", (command) => {
		expect(slashCommandAction(command)).toBe("not-built");
		expect(slashCommandAction(`${command} example argument`)).toBe("not-built");
	});
});
