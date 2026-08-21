import { Key, matchesKey, type SlashCommand } from "@earendil-works/pi-tui";
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

export function createSlashCommands(i18n: I18n = defaultI18n): SlashCommand[] {
	return [
		{ name: "compact", description: i18n.t("commandCompactDescription") },
		{ name: "clear", description: i18n.t("commandNewDescription") },
		{ name: "new", description: i18n.t("commandNewDescription") },
		{ name: "resume", description: i18n.t("commandResumeDescription") },
		{ name: "model", description: i18n.t("commandModelDescription") },
		{ name: "plan", description: i18n.t("commandPlanDescription") },
		{ name: "exit", description: i18n.t("commandExitDescription") },
		{ name: "quit", description: i18n.t("commandExitDescription") },
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
	const normalized = input.trim();
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
