import { Key, matchesKey } from "@earendil-works/pi-tui";

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
