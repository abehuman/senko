import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type OverlayHandle,
	ProcessTerminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type AutoCompactionDisplayEvent, promptWithAutoCompaction } from "../auto-compact.js";
import type { RuntimeConfig } from "../config.js";
import { contentToText, projectEvent } from "../events.js";
import { compactCommandMessage, compactCurrentSession } from "./compact.js";
import { interruptAction, slashCommandAction, slashCommands } from "./input.js";
import { listResumableSessions, ResumePicker } from "./resume.js";
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
	sessionRuntime: AgentSessionRuntime;
}): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	const transcript = new Container();
	const header = new Text(`${cyan("senko")} ${dim("fast coding agent")}`, 1, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, options.cwd));
	let activeSession = options.sessionRuntime.session;
	const sessionLabel = () => activeSession.sessionId.slice(0, 12);
	const idleFooter = () => `${options.config.model} · ${options.config.api} · ${options.cwd} · ${sessionLabel()}`;
	const workingFooter = () => `working · Esc/Ctrl+C abort · ${options.config.model} · ${sessionLabel()}`;
	const footer = new Text(dim(idleFooter()), 1, 0);
	tui.addChild(header);
	tui.addChild(transcript);
	renderHistory(transcript, activeSession.messages);
	tui.addChild(editor);
	tui.addChild(footer);
	tui.setFocus(editor);

	let busy = false;
	let closed = false;
	let activePromptCancelled = false;
	let currentAutoCompaction: Text | undefined;
	let currentAssistant: Text | undefined;
	let currentAssistantText = "";
	let currentThinking: Text | undefined;
	let currentThinkingText = "";
	const tools = new Map<string, { component: Text; label: string }>();
	let unsubscribeEvents: (() => void) | undefined;
	let resumeOverlay: OverlayHandle | undefined;
	let resumeLoading = false;
	let resumeSwitching = false;
	const displayAutoCompaction = (projected: AutoCompactionDisplayEvent) => {
		switch (projected.type) {
			case "auto_compaction_start":
				currentAutoCompaction = new Text(dim(projected.text), 1, 0);
				transcript.addChild(currentAutoCompaction);
				footer.setText(dim(`compacting · Esc/Ctrl+C abort · ${options.config.model} · ${sessionLabel()}`));
				break;
			case "auto_compaction_end": {
				const component = currentAutoCompaction ?? new Text("", 1, 0);
				if (!currentAutoCompaction) transcript.addChild(component);
				component.setText(
					projected.status === "success"
						? green(`✓ ${projected.text}`)
						: projected.status === "cancelled"
							? dim(projected.text)
							: red(projected.text),
				);
				currentAutoCompaction = undefined;
				footer.setText(dim(busy ? workingFooter() : idleFooter()));
				break;
			}
		}
		tui.requestRender();
	};

	const subscribeToSession = () => {
		unsubscribeEvents?.();
		unsubscribeEvents = activeSession.subscribe((event) => {
			for (const projected of projectEvent(event)) {
				switch (projected.type) {
					case "auto_compaction_start":
					case "auto_compaction_end":
						displayAutoCompaction(projected);
						break;
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
	};

	const rebindSession = async (session: AgentSession) => {
		activeSession = session;
		activePromptCancelled = false;
		currentAutoCompaction = undefined;
		currentAssistant = undefined;
		currentAssistantText = "";
		currentThinking = undefined;
		currentThinkingText = "";
		tools.clear();
		transcript.clear();
		renderHistory(transcript, activeSession.messages);
		subscribeToSession();
		footer.setText(dim(idleFooter()));
		tui.requestRender();
	};

	options.sessionRuntime.setBeforeSessionInvalidate(() => {
		unsubscribeEvents?.();
		unsubscribeEvents = undefined;
	});
	options.sessionRuntime.setRebindSession(rebindSession);
	subscribeToSession();

	return new Promise<number>((resolve) => {
		const finish = (code: number) => {
			if (closed) return;
			closed = true;
			resumeOverlay?.hide();
			resumeOverlay = undefined;
			unsubscribeInput();
			unsubscribeEvents?.();
			options.sessionRuntime.setBeforeSessionInvalidate(undefined);
			options.sessionRuntime.setRebindSession(undefined);
			tui.stop();
			resolve(code);
		};

		const submit = async (raw: string) => {
			const prompt = raw.trim();
			if (!prompt || busy || closed || resumeLoading || resumeSwitching || resumeOverlay) return;
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
			if (commandAction === "new-session-usage") {
				editor.addToHistory(raw);
				editor.setText("");
				transcript.addChild(new Text(red("Usage: /clear"), 1, 0));
				tui.requestRender();
				return;
			}
			if (commandAction === "new-session") {
				editor.addToHistory(raw);
				editor.setText("");
				busy = true;
				editor.disableSubmit = true;
				try {
					const result = await options.sessionRuntime.newSession();
					if (!result.cancelled) {
						terminal.clearScreen();
						tui.requestRender(true);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					terminal.clearScreen();
					terminal.write(`${red(`senko: could not start a new session: ${message}`)}\n`);
					finish(1);
					return;
				} finally {
					if (!closed) {
						busy = false;
						editor.disableSubmit = false;
						footer.setText(dim(idleFooter()));
						tui.requestRender();
					}
				}
				return;
			}
			if (commandAction === "resume-usage") {
				editor.addToHistory(raw);
				editor.setText("");
				transcript.addChild(new Text(red("Usage: /resume"), 1, 0));
				tui.requestRender();
				return;
			}
			if (commandAction === "resume") {
				editor.addToHistory(raw);
				editor.setText("");
				if (!activeSession.sessionManager.isPersisted()) {
					transcript.addChild(new Text(red("Saved-session resume is disabled with --no-session."), 1, 0));
					tui.requestRender();
					return;
				}
				resumeLoading = true;
				editor.disableSubmit = true;
				try {
					const sessions = await listResumableSessions({
						activeSessionId: activeSession.sessionId,
						cwd: options.cwd,
						sessionsDir: activeSession.sessionManager.getSessionDir(),
					});
					if (sessions.length === 0) {
						transcript.addChild(new Text(dim("No saved sessions for this directory."), 1, 0));
						tui.requestRender();
						return;
					}
					const closePicker = () => {
						resumeOverlay?.hide();
						resumeOverlay = undefined;
					};
					const resumeSession = async (path: string) => {
						if (resumeSwitching || closed) return;
						resumeSwitching = true;
						closePicker();
						try {
							const result = await options.sessionRuntime.switchSession(path);
							if (!result.cancelled) {
								terminal.clearScreen();
								tui.requestRender(true);
							}
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							terminal.clearScreen();
							terminal.write(`${red(`senko: could not resume the selected session: ${message}`)}\n`);
							finish(1);
							return;
						} finally {
							if (!closed) {
								resumeSwitching = false;
								editor.disableSubmit = false;
								footer.setText(dim(idleFooter()));
								tui.requestRender();
							}
						}
					};
					resumeOverlay = tui.showOverlay(
						new ResumePicker(sessions, {
							onCancel: closePicker,
							onSelect: (session) => void resumeSession(session.path),
						}),
						{ anchor: "center", maxHeight: "70%", width: "90%" },
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					transcript.addChild(new Text(red(`Could not list saved sessions: ${message}`), 1, 0));
					tui.requestRender();
				} finally {
					resumeLoading = false;
					if (!resumeSwitching) editor.disableSubmit = false;
				}
				return;
			}
			if (commandAction === "compact") {
				editor.addToHistory(raw);
				editor.setText("");
				const status = new Text(dim("Compacting context…"), 1, 0);
				transcript.addChild(status);
				busy = true;
				editor.disableSubmit = true;
				footer.setText(dim(`compacting · Esc/Ctrl+C abort · ${options.config.model} · ${sessionLabel()}`));
				tui.requestRender();
				const result = await compactCurrentSession(activeSession);
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
				footer.setText(dim(idleFooter()));
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
			activePromptCancelled = false;
			editor.disableSubmit = true;
			footer.setText(dim(workingFooter()));
			tui.requestRender();
			try {
				await promptWithAutoCompaction({
					config: options.config,
					isCancelled: () => activePromptCancelled,
					onDisplayEvent: displayAutoCompaction,
					prompt: raw,
					session: activeSession,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				transcript.addChild(new Text(red(`error\n${message}`), 1, 0));
			} finally {
				busy = false;
				editor.disableSubmit = false;
				footer.setText(dim(idleFooter()));
				tui.requestRender();
			}
		};

		editor.onSubmit = (text) => void submit(text);
		const unsubscribeInput = tui.addInputListener((data) => {
			if (resumeOverlay) return undefined;
			if (resumeLoading || resumeSwitching) return { consume: true };
			const action = interruptAction(data, busy);
			if (action === "abort") {
				activePromptCancelled = true;
				if (activeSession.isCompacting) {
					activeSession.abortCompaction();
				} else {
					void activeSession.abort();
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
