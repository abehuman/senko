import { decodeKittyPrintable, Editor, Key, matchesKey, type SlashCommand } from "@earendil-works/pi-tui";
import { defaultI18n, type I18n } from "../i18n/index.js";

export type InterruptAction = "abort" | "exit" | undefined;
export type SlashCommandAction =
	| "compact"
	| "compact-usage"
	| "exit"
	| "new-session"
	| "new-session-usage"
	| "not-built"
	| "resume"
	| "resume-usage"
	| undefined;

const placeholderSlashCommands = new Set([
	// Changes the active model and effort, but is not built yet.
	"/model",
	// Enables plan mode; edit mode remains the default, but this is not built yet.
	"/plan",
]);

const fullWidthCommandPrefix = "　";
const fullWidthAlphanumericPattern = /[０-９Ａ-Ｚａ-ｚ]/gu;

function includesControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || codePoint === 0x7f) {
			return true;
		}
	}
	return false;
}

function normalizeFullWidthAlphanumeric(value: string): string {
	return value.replace(fullWidthAlphanumericPattern, (character) =>
		String.fromCharCode(character.charCodeAt(0) - 0xfee0),
	);
}

function normalizeCommandToken(input: string): string {
	const leadingWhitespace = input.match(/^[ \t]*/u)?.[0] ?? "";
	const remainder = input.slice(leadingWhitespace.length);
	if (!remainder.startsWith("/") && !remainder.startsWith(fullWidthCommandPrefix)) {
		return input;
	}

	const slashPrefixed = remainder.startsWith(fullWidthCommandPrefix) ? `/${remainder.slice(1)}` : remainder;
	const commandEnd = slashPrefixed.search(/\s/u);
	const command = commandEnd === -1 ? slashPrefixed : slashPrefixed.slice(0, commandEnd);
	const suffix = commandEnd === -1 ? "" : slashPrefixed.slice(commandEnd);
	return `${leadingWhitespace}${normalizeFullWidthAlphanumeric(command)}${suffix}`;
}

export function normalizeCommandEditorInput(data: string, textBeforeCursor: string): string {
	if (includesControlCharacter(data)) {
		return data;
	}

	const commandBeforeCursor = textBeforeCursor.trimStart();
	if (commandBeforeCursor === "") {
		return data.startsWith("/") || data.startsWith(fullWidthCommandPrefix) ? normalizeCommandToken(data) : data;
	}
	if (
		(commandBeforeCursor.startsWith("/") || commandBeforeCursor.startsWith(fullWidthCommandPrefix)) &&
		!/\s/u.test(commandBeforeCursor)
	) {
		const commandEnd = data.search(/\s/u);
		const commandInput = commandEnd === -1 ? data : data.slice(0, commandEnd);
		const suffix = commandEnd === -1 ? "" : data.slice(commandEnd);
		return `${normalizeFullWidthAlphanumeric(commandInput)}${suffix}`;
	}
	return data;
}

export class SenkoEditor extends Editor {
	override handleInput(data: string): void {
		const cursor = this.getCursor();
		const currentLine = this.getLines()[cursor.line] ?? "";
		const printableInput = decodeKittyPrintable(data) ?? data;
		const normalized = normalizeCommandEditorInput(printableInput, currentLine.slice(0, cursor.col));

		if (normalized === printableInput) {
			super.handleInput(data);
			return;
		}

		for (const character of normalized) {
			super.handleInput(character);
		}
	}
}

export function createSlashCommands(i18n: I18n = defaultI18n): SlashCommand[] {
	return [
		{ name: "compact", description: i18n.t("commandCompactDescription") },
		{ name: "clear", description: i18n.t("commandNewDescription") },
		{ name: "resume", description: i18n.t("commandResumeDescription") },
		{ name: "model", description: i18n.t("commandModelDescription") },
		{ name: "plan", description: i18n.t("commandPlanDescription") },
		{ name: "exit", description: i18n.t("commandExitDescription") },
	];
}

export const slashCommands = createSlashCommands();

export function interruptAction(data: string, busy: boolean): InterruptAction {
	if (matchesKey(data, Key.escape)) {
		return busy ? "abort" : undefined;
	}
	if (matchesKey(data, Key.ctrl("c"))) {
		return busy ? "abort" : "exit";
	}
	return undefined;
}

export function slashCommandAction(input: string): SlashCommandAction {
	const normalized = normalizeCommandToken(input).trim();
	if (normalized === "/exit" || normalized === "/quit") {
		return "exit";
	}
	if (normalized === "/compact") {
		return "compact";
	}
	const [command] = normalized.split(/\s+/, 1);
	if (command === "/compact") {
		return "compact-usage";
	}
	if (command === "/clear" || command === "/new") {
		return normalized === command ? "new-session" : "new-session-usage";
	}
	if (command === "/resume") {
		return normalized === command ? "resume" : "resume-usage";
	}
	if (command && placeholderSlashCommands.has(command)) {
		return "not-built";
	}
	return undefined;
}
