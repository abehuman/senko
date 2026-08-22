import type { EditorTheme } from "@earendil-works/pi-tui";

const color = (open: number | string, close: number) => (text: string) =>
	process.stdout.isTTY ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const lime = color("38;2;164;243;116", 39);
export const dim = color(2, 22);
export const green = color(32, 39);
export const red = color(31, 39);

const identity = (text: string) => text;

export const editorTheme: EditorTheme = {
	borderColor: lime,
	selectList: {
		description: dim,
		noMatch: dim,
		scrollInfo: dim,
		selectedPrefix: lime,
		selectedText: identity,
	},
};
