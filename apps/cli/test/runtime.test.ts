import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";
import { startMockInferenceServer } from "./helpers/mock-inference-server.js";

const temporaryDirectories: string[] = [];
const openServers: Array<{ close(): Promise<void> }> = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function runtimeConfig(root: string, baseUrl: string): RuntimeConfig {
	return {
		api: "openai-completions",
		apiKey: "test-key",
		baseUrl,
		configPath: join(root, "config", "senko.json"),
		contextWindow: 32_768,
		isLoopback: true,
		maxOutputTokens: 4_096,
		model: "fast",
		reasoning: false,
	};
}

afterEach(async () => {
	await Promise.all(openServers.splice(0).map((server) => server.close()));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("session runtime", () => {
	it("replaces a persisted session without sending a model request for the transition", async () => {
		const root = await temporaryDirectory("senko-runtime-");
		const cwd = join(root, "workspace");
		const sessionsDir = join(root, "state", "sessions");
		await mkdir(cwd, { recursive: true });
		const server = await startMockInferenceServer({ protocol: "openai-completions" });
		openServers.push(server);
		const runtime = await createRuntime({
			config: runtimeConfig(root, server.baseUrl),
			cwd,
			home: join(root, "home"),
			sessionManager: SessionManager.create(cwd, sessionsDir),
		});

		try {
			const firstSessionId = runtime.sessionRuntime.session.sessionId;
			await runtime.sessionRuntime.session.prompt("before clear", { source: "interactive" });
			const requestCountBeforeClear = server.requests.length;

			const result = await runtime.sessionRuntime.newSession();

			expect(result.cancelled).toBe(false);
			expect(runtime.sessionRuntime.session.sessionId).not.toBe(firstSessionId);
			expect(server.requests).toHaveLength(requestCountBeforeClear);

			await runtime.sessionRuntime.session.prompt("after clear", { source: "interactive" });
			const sessions = await SessionManager.list(cwd, sessionsDir);
			expect(sessions.map((session) => session.id)).toEqual(
				expect.arrayContaining([firstSessionId, runtime.sessionRuntime.session.sessionId]),
			);
			expect(JSON.stringify(server.requests.at(-1)?.body)).toContain("after clear");
			expect(JSON.stringify(server.requests.at(-1)?.body)).not.toContain("before clear");
		} finally {
			await runtime.sessionRuntime.dispose();
		}
	});

	it("keeps replacement sessions in memory when started with --no-session", async () => {
		const root = await temporaryDirectory("senko-runtime-ephemeral-");
		const cwd = join(root, "workspace");
		const sessionsDir = join(root, "state", "sessions");
		await mkdir(cwd, { recursive: true });
		const runtime = await createRuntime({
			config: runtimeConfig(root, "http://127.0.0.1:1/v1"),
			cwd,
			home: join(root, "home"),
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			const firstSessionId = runtime.sessionRuntime.session.sessionId;
			const result = await runtime.sessionRuntime.newSession();

			expect(result.cancelled).toBe(false);
			expect(runtime.sessionRuntime.session.sessionId).not.toBe(firstSessionId);
			expect(await SessionManager.list(cwd, sessionsDir)).toEqual([]);
		} finally {
			await runtime.sessionRuntime.dispose();
		}
	});
});
