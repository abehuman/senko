import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { defaultI18n, type I18n } from "../i18n/index.js";
import { dim, editorTheme, lime } from "./theme.js";

const WIDE_VISIBLE_SESSIONS = 8;
const NARROW_VISIBLE_SESSIONS = 4;

interface ResumeSessionRow {
	date: string;
	item: SelectItem;
	prompt: string;
}

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

function resumeSessionRow(session: SessionInfo, i18n: I18n): ResumeSessionRow {
	const prompt = sessionPrompt(session, i18n);
	const date = sessionDate(session);
	return {
		date,
		item: {
			label: `${prompt}  ${date}`,
			value: session.path,
		},
		prompt,
	};
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
	return sessions.map((session) => resumeSessionRow(session, i18n).item);
}

export class ResumePicker implements Component {
	private readonly rows: ResumeSessionRow[];
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
		this.rows = sessions.map((session) => resumeSessionRow(session, this.i18n));
		this.sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
		this.selectList = new SelectList(
			this.rows.map((row) => row.item),
			WIDE_VISIBLE_SESSIONS,
			editorTheme.selectList,
		);
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

	private renderSessions(width: number): string[] {
		const selected = this.selectList.getSelectedItem();
		const selectedIndex = Math.max(
			0,
			this.rows.findIndex((row) => row.item.value === selected?.value),
		);
		const twoLineRows = this.rows.some((row) => visibleWidth(row.item.label) + 2 > width);
		const maxVisible = twoLineRows ? NARROW_VISIBLE_SESSIONS : WIDE_VISIBLE_SESSIONS;
		const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), this.rows.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.rows.length);
		const lines: string[] = [];

		for (let index = startIndex; index < endIndex; index += 1) {
			const row = this.rows[index];
			if (!row) continue;
			const isSelected = index === selectedIndex;
			const prefix = isSelected ? "→ " : "  ";
			if (!twoLineRows) {
				const line = `${prefix}${row.item.label}`;
				lines.push(isSelected ? editorTheme.selectList.selectedText(line) : line);
				continue;
			}

			const prompt = truncateToWidth(row.prompt, Math.max(1, width - visibleWidth(prefix)), "");
			const promptLine = `${prefix}${prompt}`;
			const dateIndent = width >= 12 ? "  " : "";
			const date = truncateToWidth(row.date, Math.max(1, width - visibleWidth(dateIndent)), "");
			const dateLine = `${dateIndent}${date}`;
			lines.push(
				isSelected ? editorTheme.selectList.selectedText(promptLine) : promptLine,
				isSelected ? editorTheme.selectList.selectedText(dateLine) : dateLine,
			);
		}

		if (startIndex > 0 || endIndex < this.rows.length) {
			const scrollText = truncateToWidth(`  (${selectedIndex + 1}/${this.rows.length})`, Math.max(1, width - 2), "");
			lines.push(editorTheme.selectList.scrollInfo(scrollText));
		}

		return lines;
	}

	render(width: number): string[] {
		const i18n = this.i18n;
		return [lime(i18n.t("resumeTitle")), dim(i18n.t("resumeHint")), "", ...this.renderSessions(width)];
	}
}
