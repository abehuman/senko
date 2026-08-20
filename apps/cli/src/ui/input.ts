import { Key, matchesKey } from "@earendil-works/pi-tui";

export type InterruptAction = "abort" | "exit" | undefined;

export function interruptAction(data: string, busy: boolean): InterruptAction {
	if (matchesKey(data, Key.escape)) {
		return busy ? "abort" : undefined;
	}
	if (matchesKey(data, Key.ctrl("c"))) {
		return busy ? "abort" : "exit";
	}
	return undefined;
}
