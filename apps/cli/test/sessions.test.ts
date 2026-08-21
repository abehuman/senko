import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n/index.js";
import { formatSessions, listSessions, selectSessionManager } from "../src/sessions.js";

const temporaryDirectories: string[] = [];

async function makeDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("session selection", () => {
	it("creates, continues, resumes, and keeps ephemeral sessions in memory", async () => {
		const cwd = await makeDirectory("senko-session-cwd-");
		const sessionsDir = await makeDirectory("senko-session-state-");
		const created = await selectSessionManager({
			args: { continueSession: false, noSession: false },
			cwd,
			sessionsDir,
		});
		created.appendMessage({ content: "first prompt", role: "user", timestamp: Date.now() });
		created.appendMessage({
			api: "openai-completions",
			content: [{ text: "first reply", type: "text" }],
			model: "fast",
			provider: "senko",
			role: "assistant",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				cacheRead: 0,
				cacheWrite: 0,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
				input: 0,
				output: 0,
				reasoning: 0,
				totalTokens: 0,
			},
		});
		const listed = await listSessions(cwd, sessionsDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe(created.getSessionId());

		const continued = await selectSessionManager({
			args: { continueSession: true, noSession: false },
			cwd,
			sessionsDir,
		});
		expect(continued.getSessionId()).toBe(created.getSessionId());

		const resumed = await selectSessionManager({
			args: { continueSession: false, noSession: false, resumeId: created.getSessionId().slice(0, 10) },
			cwd,
			sessionsDir,
		});
		expect(resumed.getSessionId()).toBe(created.getSessionId());

		const ephemeral = await selectSessionManager({
			args: { continueSession: false, noSession: true },
			cwd,
			sessionsDir,
		});
		expect(ephemeral.isPersisted()).toBe(false);
	});

	it("formats a compact session listing", () => {
		const session: SessionInfo = {
			allMessagesText: "first prompt reply",
			created: new Date("2026-08-20T01:02:03.000Z"),
			cwd: "/work",
			firstMessage: "first prompt",
			id: "session-123",
			messageCount: 2,
			modified: new Date("2026-08-20T01:03:04.000Z"),
			path: "/state/session.jsonl",
		};
		expect(formatSessions([])).toBe("No sessions for this directory.");
		expect(formatSessions([session])).toContain("session-123");
		expect(formatSessions([session])).toContain("first prompt");
		expect(formatSessions([], createI18n("ja"))).toBe("このディレクトリにセッションはありません。");
	});
});
