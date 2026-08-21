import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CliArgs } from "./args.js";
import { SenkoError } from "./errors.js";
import { defaultI18n, type I18n } from "./i18n/index.js";

async function findSession(cwd: string, sessionsDir: string, id: string, i18n: I18n): Promise<SessionInfo> {
	const sessions = await SessionManager.list(cwd, sessionsDir);
	const exact = sessions.find((session) => session.id === id);
	if (exact) {
		return exact;
	}
	const matches = sessions.filter((session) => session.id.startsWith(id));
	if (matches.length === 0) {
		throw new SenkoError(i18n.t("sessionNotFound", { cwd, id }));
	}
	if (matches.length > 1) {
		throw new SenkoError(i18n.t("sessionAmbiguous", { id }));
	}
	const match = matches[0];
	if (!match) {
		throw new SenkoError(i18n.t("sessionNotFound", { cwd, id }));
	}
	return match;
}

export async function selectSessionManager(
	options: {
		args: Pick<CliArgs, "continueSession" | "noSession" | "resumeId">;
		cwd: string;
		sessionsDir: string;
	},
	i18n: I18n = defaultI18n,
): Promise<SessionManager> {
	if (options.args.noSession) {
		return SessionManager.inMemory(options.cwd);
	}
	if (options.args.resumeId) {
		const session = await findSession(options.cwd, options.sessionsDir, options.args.resumeId, i18n);
		return SessionManager.open(session.path, options.sessionsDir);
	}
	if (options.args.continueSession) {
		return SessionManager.continueRecent(options.cwd, options.sessionsDir);
	}
	return SessionManager.create(options.cwd, options.sessionsDir);
}

export async function listSessions(cwd: string, sessionsDir: string): Promise<SessionInfo[]> {
	return SessionManager.list(cwd, sessionsDir);
}

export function formatSessions(sessions: SessionInfo[], i18n: I18n = defaultI18n): string {
	if (sessions.length === 0) {
		return i18n.t("sessionsNone");
	}
	const idWidth = Math.max(10, ...sessions.map((session) => session.id.length));
	return sessions
		.map((session) => {
			const date = i18n.dateTime(session.modified);
			const label = session.name || session.firstMessage.replace(/\s+/g, " ").trim() || i18n.t("sessionEmpty");
			return `${session.id.padEnd(idWidth)}  ${date}  ${i18n.number(session.messageCount).padStart(3)}  ${label.slice(0, 80)}`;
		})
		.join("\n");
}
