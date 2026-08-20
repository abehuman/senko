import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CliArgs } from "./args.js";
import { SenkoError } from "./errors.js";

async function findSession(cwd: string, sessionsDir: string, id: string): Promise<SessionInfo> {
	const sessions = await SessionManager.list(cwd, sessionsDir);
	const exact = sessions.find((session) => session.id === id);
	if (exact) {
		return exact;
	}
	const matches = sessions.filter((session) => session.id.startsWith(id));
	if (matches.length === 0) {
		throw new SenkoError(`No session matching "${id}" exists for ${cwd}.`);
	}
	if (matches.length > 1) {
		throw new SenkoError(`Session prefix "${id}" is ambiguous; provide more characters.`);
	}
	const match = matches[0];
	if (!match) {
		throw new SenkoError(`No session matching "${id}" exists for ${cwd}.`);
	}
	return match;
}

export async function selectSessionManager(options: {
	args: Pick<CliArgs, "continueSession" | "noSession" | "resumeId">;
	cwd: string;
	sessionsDir: string;
}): Promise<SessionManager> {
	if (options.args.noSession) {
		return SessionManager.inMemory(options.cwd);
	}
	if (options.args.resumeId) {
		const session = await findSession(options.cwd, options.sessionsDir, options.args.resumeId);
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

export function formatSessions(sessions: SessionInfo[]): string {
	if (sessions.length === 0) {
		return "No sessions for this directory.";
	}
	const idWidth = Math.max(10, ...sessions.map((session) => session.id.length));
	return sessions
		.map((session) => {
			const date = session.modified
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d{3}Z$/, "Z");
			const label = session.name || session.firstMessage.replace(/\s+/g, " ").trim() || "(empty session)";
			return `${session.id.padEnd(idWidth)}  ${date}  ${session.messageCount.toString().padStart(3)}  ${label.slice(0, 80)}`;
		})
		.join("\n");
}
