import { CombinedAutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createI18n } from "../src/i18n/index.js";
import {
	createSlashCommands,
	interruptAction,
	normalizeCommandEditorInput,
	SenkoEditor,
	slashCommandAction,
	slashCommands,
} from "../src/ui/input.js";
import { editorTheme } from "../src/ui/theme.js";

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

	it("opens and filters slash command completion with a full-width space", async () => {
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const editor = new SenkoEditor(tui, editorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));

		editor.handleInput("　ｃ");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(editor.getText()).toBe("/c");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/compact ");
	});

	it("normalizes full-width command input sent with the Kitty keyboard protocol", async () => {
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const editor = new SenkoEditor(tui, editorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));

		editor.handleInput("\x1b[12288u");
		editor.handleInput("\x1b[65347u");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		expect(editor.getText()).toBe("/c");
	});

	it("normalizes full-width command input without changing ordinary prompts", () => {
		expect(normalizeCommandEditorInput("　ｃ", "")).toBe("/c");
		expect(normalizeCommandEditorInput("ｃ", "/")).toBe("c");
		expect(normalizeCommandEditorInput("ｃ", "/compact ")).toBe("ｃ");
		expect(normalizeCommandEditorInput("ｃ", "日本語")).toBe("ｃ");
		expect(normalizeCommandEditorInput("　", "日本語")).toBe("　");
	});

	it("lists primary commands without aliases when the user types slash", async () => {
		const provider = new CombinedAutocompleteProvider(slashCommands, process.cwd());
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"compact",
			"clear",
			"resume",
			"model",
			"plan",
			"exit",
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
		expect(slashCommandAction("　ｃｏｍｐａｃｔ")).toBe("compact");
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
