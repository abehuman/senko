import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { defaultI18n, type I18n } from "../i18n/index.js";
import { dim, editorTheme, lime } from "./theme.js";

function sessionPrompt(session: SessionInfo, i18n: I18n): string {
	const prompt = session.firstMessage.replace(/\s+/g, " ").trim() || i18n.t("sessionEmpty");
	return Array.from(prompt).slice(0, 14).join("");
}

function sessionDate(session: SessionInfo): string {
	const year = String(session.modified.getFullYear()).padStart(4, "0");
	const month = String(session.modified.getMonth() + 1).padStart(2, "0");
	const day = String(session.modified.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
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
		label: `${sessionPrompt(session, i18n)}  ${sessionDate(session)}`,
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
		return [lime(i18n.t("resumeTitle")), dim(i18n.t("resumeHint")), "", ...this.selectList.render(width)];
	}
}
