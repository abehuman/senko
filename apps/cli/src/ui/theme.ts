import type { EditorTheme } from "@earendil-works/pi-tui";

const color = (open: number, close: number) => (text: string) =>
	process.stdout.isTTY ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const cyan = color(36, 39);
export const dim = color(2, 22);
export const green = color(32, 39);
export const red = color(31, 39);

const identity = (text: string) => text;

export const editorTheme: EditorTheme = {
	borderColor: cyan,
	selectList: {
		description: dim,
		noMatch: dim,
		scrollInfo: dim,
		selectedPrefix: cyan,
		selectedText: identity,
	},
};
