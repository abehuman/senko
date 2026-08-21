import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Container, Editor, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import type { RuntimeConfig } from "../config.js";
import { contentToText, projectEvent } from "../events.js";
import { compactCommandMessage, compactCurrentSession } from "./compact.js";
import { interruptAction, slashCommandAction } from "./input.js";
import { cyan, dim, editorTheme, green, red } from "./theme.js";

type SessionMessage = AgentSession["messages"][number];

function messageText(message: SessionMessage): string {
	if (!("content" in message)) {
		return "";
	}
	return contentToText(message.content);
}

function renderHistory(transcript: Container, messages: SessionMessage[]): void {
	for (const message of messages) {
		const text = messageText(message);
		if (!text) continue;
		if (message.role === "user") {
			transcript.addChild(new Text(`${cyan("you")}\n${text}`, 1, 0));
		} else if (message.role === "assistant") {
			transcript.addChild(new Text(`${green("senko")}\n${text}`, 1, 0));
		} else if (message.role === "toolResult") {
			transcript.addChild(new Text(dim(`tool\n${text}`), 1, 0));
		}
	}
}

export async function runInteractiveMode(options: {
	config: RuntimeConfig;
	cwd: string;
	initialPrompt?: string;
	session: AgentSession;
}): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	const transcript = new Container();
	const header = new Text(`${cyan("senko")} ${dim("fast coding agent")}`, 1, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	const sessionLabel = options.session.sessionId.slice(0, 12);
	const footer = new Text(
		dim(`${options.config.model} · ${options.config.api} · ${options.cwd} · ${sessionLabel}`),
		1,
		0,
	);
	tui.addChild(header);
	tui.addChild(transcript);
	renderHistory(transcript, options.session.messages);
	tui.addChild(editor);
	tui.addChild(footer);
	tui.setFocus(editor);

	let busy = false;
	let closed = false;
	let currentAssistant: Text | undefined;
	let currentAssistantText = "";
	let currentThinking: Text | undefined;
	let currentThinkingText = "";
	const tools = new Map<string, { component: Text; label: string }>();

	const unsubscribeEvents = options.session.subscribe((event) => {
		for (const projected of projectEvent(event)) {
			switch (projected.type) {
				case "assistant_start":
					currentAssistantText = "";
					currentThinkingText = "";
					currentThinking = undefined;
					currentAssistant = new Text(`${green("senko")}\n`, 1, 0);
					transcript.addChild(currentAssistant);
					break;
				case "text_delta":
					currentAssistantText += projected.text;
					currentAssistant ??= new Text(`${green("senko")}\n`, 1, 0);
					if (!transcript.children.includes(currentAssistant)) transcript.addChild(currentAssistant);
					currentAssistant.setText(`${green("senko")}\n${currentAssistantText}`);
					break;
				case "thinking_delta":
					currentThinkingText += projected.text;
					if (!currentThinking) {
						currentThinking = new Text(dim("thinking…"), 1, 0);
						transcript.addChild(currentThinking);
					}
					currentThinking.setText(dim(`thinking\n${currentThinkingText}`));
					break;
				case "tool_start": {
					const component = new Text(cyan(`→ ${projected.label}`), 1, 0);
					tools.set(projected.id, { component, label: projected.label });
					transcript.addChild(component);
					break;
				}
				case "tool_update": {
					const tool = tools.get(projected.id);
					if (tool && projected.text) tool.component.setText(`${cyan(`→ ${tool.label}`)}\n${dim(projected.text)}`);
					break;
				}
				case "tool_end": {
					const tool = tools.get(projected.id);
					if (tool) {
						const status = projected.isError ? red("✗") : green("✓");
						const detail = projected.text ? `\n${dim(projected.text)}` : "";
						tool.component.setText(`${status} ${tool.label}${detail}`);
					}
					break;
				}
				case "error":
					transcript.addChild(new Text(red(`error\n${projected.text}`), 1, 0));
					break;
			}
		}
		tui.requestRender();
	});

	return new Promise<number>((resolve) => {
		const finish = (code: number) => {
			if (closed) return;
			closed = true;
			unsubscribeInput();
			unsubscribeEvents();
			tui.stop();
			resolve(code);
		};

		const submit = async (raw: string) => {
			const prompt = raw.trim();
			if (!prompt || busy || closed) return;
			const commandAction = slashCommandAction(prompt);
			if (commandAction === "exit") {
				finish(0);
				return;
			}
			if (commandAction === "compact-usage") {
				editor.addToHistory(raw);
				editor.setText("");
				transcript.addChild(new Text(red("Usage: /compact"), 1, 0));
				tui.requestRender();
				return;
			}
			if (commandAction === "compact") {
				editor.addToHistory(raw);
				editor.setText("");
				const status = new Text(dim("Compacting context…"), 1, 0);
				transcript.addChild(status);
				busy = true;
				editor.disableSubmit = true;
				footer.setText(dim(`compacting · Esc/Ctrl+C abort · ${options.config.model} · ${sessionLabel}`));
				tui.requestRender();
				const result = await compactCurrentSession(options.session);
				const message = compactCommandMessage(result);
				status.setText(
					result.status === "success"
						? green(`✓ ${message}`)
						: result.status === "cancelled"
							? dim(message)
							: red(message),
				);
				busy = false;
				editor.disableSubmit = false;
				footer.setText(dim(`${options.config.model} · ${options.config.api} · ${options.cwd} · ${sessionLabel}`));
				tui.requestRender();
				return;
			}
			if (commandAction === "not-built") {
				editor.addToHistory(raw);
				editor.setText("");
				transcript.addChild(new Text(`${green("senko")}\nThis feature is not built yet.`, 1, 0));
				tui.requestRender();
				return;
			}
			editor.addToHistory(raw);
			editor.setText("");
			transcript.addChild(new Text(`${cyan("you")}\n${raw}`, 1, 0));
			busy = true;
			editor.disableSubmit = true;
			footer.setText(dim(`working · Esc/Ctrl+C abort · ${options.config.model} · ${sessionLabel}`));
			tui.requestRender();
			try {
				await options.session.prompt(raw, { source: "interactive" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				transcript.addChild(new Text(red(`error\n${message}`), 1, 0));
			} finally {
				busy = false;
				editor.disableSubmit = false;
				footer.setText(dim(`${options.config.model} · ${options.config.api} · ${options.cwd} · ${sessionLabel}`));
				tui.requestRender();
			}
		};

		editor.onSubmit = (text) => void submit(text);
		const unsubscribeInput = tui.addInputListener((data) => {
			const action = interruptAction(data, busy);
			if (action === "abort") {
				if (options.session.isCompacting) {
					options.session.abortCompaction();
				} else {
					void options.session.abort();
				}
				return { consume: true };
			}
			if (action === "exit") {
				finish(0);
				return { consume: true };
			}
			return undefined;
		});

		tui.start();
		const initialPrompt = options.initialPrompt;
		if (initialPrompt) {
			queueMicrotask(() => void submit(initialPrompt));
		}
	});
}
