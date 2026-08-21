import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { cyan, dim, editorTheme } from "./theme.js";

function sessionLabel(session: SessionInfo): string {
	return session.name || session.firstMessage.replace(/\s+/g, " ").trim() || "(empty session)";
}

function sessionTime(session: SessionInfo): string {
	return session.modified
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "Z");
}

export function resumableSessions(sessions: SessionInfo[], activeSessionId: string): SessionInfo[] {
	return sessions
		.filter((session) => session.id !== activeSessionId)
		.sort((left, right) => right.modified.getTime() - left.modified.getTime() || left.id.localeCompare(right.id));
}

export async function listResumableSessions(options: {
	activeSessionId: string;
	cwd: string;
	sessionsDir: string;
}): Promise<SessionInfo[]> {
	return resumableSessions(await SessionManager.list(options.cwd, options.sessionsDir), options.activeSessionId);
}

export function resumeSessionItems(sessions: SessionInfo[]): SelectItem[] {
	return sessions.map((session) => ({
		description: `${sessionTime(session)} · ${session.messageCount} messages · ${sessionLabel(session)}`,
		label: session.id.slice(0, 12),
		value: session.path,
	}));
}

export class ResumePicker implements Component {
	private readonly sessionsByPath: Map<string, SessionInfo>;
	private readonly selectList: SelectList;

	constructor(
		sessions: SessionInfo[],
		callbacks: {
			onCancel(): void;
			onSelect(session: SessionInfo): void;
		},
	) {
		this.sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
		this.selectList = new SelectList(resumeSessionItems(sessions), 8, editorTheme.selectList);
		this.selectList.onCancel = callbacks.onCancel;
		this.selectList.onSelect = (item) => {
			const session = this.sessionsByPath.get(item.value);
			if (session) callbacks.onSelect(session);
		};
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		this.selectList.invalidate();
	}

	render(width: number): string[] {
		return [
			cyan("Resume session"),
			dim("↑/↓ select · Enter resume · Esc cancel"),
			"",
			...this.selectList.render(width),
		];
	}
}
