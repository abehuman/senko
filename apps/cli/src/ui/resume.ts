import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { defaultI18n, type I18n } from "../i18n/index.js";
import { cyan, dim, editorTheme } from "./theme.js";

function sessionLabel(session: SessionInfo, i18n: I18n): string {
	return session.name || session.firstMessage.replace(/\s+/g, " ").trim() || i18n.t("sessionEmpty");
}

function sessionTime(session: SessionInfo, i18n: I18n): string {
	return i18n.dateTime(session.modified);
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

export function resumeSessionItems(sessions: SessionInfo[], i18n: I18n = defaultI18n): SelectItem[] {
	return sessions.map((session) => ({
		description: `${sessionTime(session, i18n)} · ${i18n.t("sessionMessages", { count: session.messageCount })} · ${sessionLabel(session, i18n)}`,
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
		private readonly i18n: I18n = defaultI18n,
	) {
		this.sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
		this.selectList = new SelectList(resumeSessionItems(sessions, this.i18n), 8, editorTheme.selectList);
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
		const i18n = this.i18n;
		return [cyan(i18n.t("resumeTitle")), dim(i18n.t("resumeHint")), "", ...this.selectList.render(width)];
	}
}
