import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MockProtocol, type MockScenario, startMockInferenceServer } from "./helpers/mock-inference-server.js";
import { runCli } from "./helpers/run-cli.js";

const temporaryDirectories: string[] = [];
const openServers: Array<{ close(): Promise<void> }> = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function startServer(protocol: MockProtocol, scenario: MockScenario = "text") {
	const server = await startMockInferenceServer({ protocol, scenario });
	openServers.push(server);
	return server;
}

function runtimeEnvironment(baseUrl: string, root: string, apiKey = "integration-secret"): NodeJS.ProcessEnv {
	return {
		HOME: join(root, "home"),
		SENKO_API_KEY: apiKey,
		SENKO_BASE_URL: baseUrl,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_STATE_HOME: join(root, "state"),
	};
}

async function filesBelow(path: string): Promise<string[]> {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		const nested = await Promise.all(
			entries.map(async (entry) => {
				const child = join(path, entry.name);
				return entry.isDirectory() ? filesBelow(child) : [child];
			}),
		);
		return nested.flat();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function isCompactionRequest(request: { body: Record<string, unknown> }): boolean {
	return JSON.stringify(request.body).includes("structured context checkpoint summary");
}

function requestedOutputTokens(protocol: MockProtocol, body: Record<string, unknown>): unknown {
	return protocol === "openai-responses" ? body.max_output_tokens : (body.max_completion_tokens ?? body.max_tokens);
}

afterEach(async () => {
	await Promise.all(openServers.splice(0).map((server) => server.close()));
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe.sequential("CLI integration", () => {
	it.each([
		["en", "Usage:"],
		["ja", "使い方:"],
	])("renders --help in %s", async (locale, marker) => {
		const root = await temporaryDirectory("senko-help-locale-");
		const result = await runCli({
			args: ["--language", locale, "--help"],
			cwd: root,
			env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
		});

		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(result.stdout).toContain(marker);
		expect(result.stdout).toContain("--language <locale>");
	});

	it("detects the interface language from the launch environment", async () => {
		const root = await temporaryDirectory("senko-detected-locale-");
		const result = await runCli({
			args: ["--help"],
			cwd: root,
			env: {
				HOME: join(root, "home"),
				LANG: "ja_JP.UTF-8",
				XDG_CONFIG_HOME: join(root, "config"),
			},
		});

		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(result.stdout).toContain("使い方:");
	});

	it.each([
		["en", "To connect to an inference API", "Senko does not load .env files automatically."],
		["ja", "推論APIへ接続する場合", "Senkoは.envファイルを自動では読み込みません。"],
	])("explains how to recover from a missing API key in %s", async (locale, guidance, envNotice) => {
		const root = await temporaryDirectory("senko-api-key-guidance-");
		const result = await runCli({
			args: ["--language", locale, "--print", "hello", "--no-session"],
			cwd: root,
			env: {
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
			},
		});

		expect(result).toMatchObject({ code: 1, stdout: "" });
		expect(result.stderr).toContain(guidance);
		expect(result.stderr).toContain("export SENKO_API_KEY='your-api-key'");
		expect(result.stderr).toContain("SENKO_BASE_URL=http://127.0.0.1:1 pnpm dev");
		expect(result.stderr).toContain(envNotice);
	});

	it("localizes session listing without requiring inference configuration", async () => {
		const root = await temporaryDirectory("senko-session-locale-");
		const result = await runCli({
			args: ["--language", "ja", "sessions"],
			cwd: root,
			env: {
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_STATE_HOME: join(root, "state"),
			},
		});

		expect(result).toEqual({ code: 0, stderr: "", stdout: "このディレクトリにセッションはありません。\n" });
	});

	it.each<MockProtocol>(["openai-completions", "openai-responses"])(
		"streams print output through %s",
		async (protocol) => {
			const root = await temporaryDirectory("senko-protocol-");
			const cwd = join(root, "workspace");
			await mkdir(cwd);
			const server = await startServer(protocol);
			const result = await runCli({
				args: ["--print", "answer pong", "--api", protocol, "--no-session"],
				cwd,
				env: runtimeEnvironment(server.baseUrl, root),
			});

			expect(result).toEqual({ code: 0, stderr: "", stdout: "pong\n" });
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.headers.authorization).toBe("Bearer integration-secret");
			expect(server.requests[0]?.body).toMatchObject({ model: "fast", stream: true });
			expect(server.requests[0]?.path).toBe(
				protocol === "openai-completions" ? "/v1/chat/completions" : "/v1/responses",
			);
		},
	);

	it("automatically uses print mode for piped stdin", async () => {
		const root = await temporaryDirectory("senko-stdin-");
		const cwd = join(root, "workspace");
		await mkdir(cwd);
		const server = await startServer("openai-completions");
		const result = await runCli({
			args: ["--no-session"],
			cwd,
			env: runtimeEnvironment(server.baseUrl, root),
			input: "answer from stdin",
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("pong\n");
		expect(JSON.stringify(server.requests[0]?.body)).toContain("answer from stdin");
	});

	it("executes read, write, edit, and shell tools without approval", async () => {
		const root = await temporaryDirectory("senko-tools-");
		const cwd = join(root, "workspace");
		await mkdir(cwd);
		const server = await startServer("openai-completions", "tools");
		const result = await runCli({
			args: ["--print", "run every tool", "--no-session"],
			cwd,
			env: runtimeEnvironment(server.baseUrl, root),
			timeoutMs: 25_000,
		});

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toBe("tools complete\n");
		expect(result.stderr).toContain("→ write artifact.txt");
		expect(result.stderr).toContain("→ read artifact.txt");
		expect(result.stderr).toContain("→ edit artifact.txt");
		expect(result.stderr).toContain("→ bash printf");
		expect(await readFile(join(cwd, "artifact.txt"), "utf8")).toBe("beta\n");
		expect(await readFile(join(cwd, "shell.txt"), "utf8")).toBe("shell-ok\n");
		expect(server.requests).toHaveLength(5);
	});

	it.each<MockProtocol>(["openai-completions", "openai-responses"])(
		"compacts before a pending prompt crosses the safe threshold through %s",
		async (protocol) => {
			const root = await temporaryDirectory("senko-preflight-compact-");
			const cwd = join(root, "workspace");
			await mkdir(cwd);
			const server = await startServer(protocol, "preflight-compact");
			const env = runtimeEnvironment(server.baseUrl, root);
			const protocolArgs = ["--api", protocol];

			const first = await runCli({ args: protocolArgs, cwd, env, input: "first turn" });
			expect(first.code, first.stderr).toBe(0);
			const second = await runCli({
				args: ["--continue", ...protocolArgs],
				cwd,
				env,
				input: `second turn\n${"b".repeat(90_000)}`,
				timeoutMs: 25_000,
			});
			expect(second.code, second.stderr).toBe(0);

			const continued = await runCli({
				args: ["--continue", ...protocolArgs],
				cwd,
				env,
				input: `third turn\n${"c".repeat(8_000)}`,
				timeoutMs: 25_000,
			});

			expect(continued.code, continued.stderr).toBe(0);
			expect(continued.stdout).toBe("pong\n");
			expect(continued.stderr).toContain("Auto-compacting context before the limit…");
			expect(continued.stderr).toContain("Context auto-compacted:");
			expect(continued.stderr).not.toContain("Context limit reached");
			expect(server.requests.map(isCompactionRequest)).toEqual([false, false, true, false]);

			const summaryRequest = server.requests[2];
			expect(Number(requestedOutputTokens(protocol, summaryRequest?.body ?? {}))).toBeGreaterThan(0);
			expect(Number(requestedOutputTokens(protocol, summaryRequest?.body ?? {}))).toBeLessThanOrEqual(4_096);
			expect(JSON.stringify(server.requests[3]?.body)).toContain("mock compacted summary");

			const sessionsDirectory = join(root, "state", "senko", "sessions");
			const sessionFiles = (await filesBelow(sessionsDirectory)).filter((path) => path.endsWith(".jsonl"));
			expect(sessionFiles).toHaveLength(1);
			const sessionSource = await readFile(sessionFiles[0] ?? "", "utf8");
			expect(sessionSource).toContain('"type":"compaction"');
			expect(sessionSource).not.toContain("integration-secret");
		},
	);

	it.each<MockProtocol>(["openai-completions", "openai-responses"])(
		"compacts and retries exactly once after a %s context overflow",
		async (protocol) => {
			const root = await temporaryDirectory("senko-overflow-compact-");
			const cwd = join(root, "workspace");
			await mkdir(cwd);
			const server = await startServer(protocol, "overflow-recovery");
			const env = runtimeEnvironment(server.baseUrl, root);
			const protocolArgs = ["--api", protocol];

			const first = await runCli({ args: protocolArgs, cwd, env, input: "first turn" });
			expect(first.code, first.stderr).toBe(0);
			const recovered = await runCli({
				args: ["--continue", ...protocolArgs],
				cwd,
				env,
				input: `overflow turn\n${"x".repeat(90_000)}`,
				timeoutMs: 25_000,
			});

			expect(recovered.code, recovered.stderr).toBe(0);
			expect(recovered.stdout).toBe("pong\n");
			expect(recovered.stderr).toContain("Context limit reached; auto-compacting before retry…");
			expect(recovered.stderr).toContain("Retrying the request.");
			expect(recovered.stderr).not.toContain("Auto-compacting context before the limit…");
			expect(server.requests.map(isCompactionRequest)).toEqual([false, false, true, false]);
			expect(JSON.stringify(server.requests[3]?.body)).toContain("mock compacted summary");

			const sessionsDirectory = join(root, "state", "senko", "sessions");
			const sessionFiles = (await filesBelow(sessionsDirectory)).filter((path) => path.endsWith(".jsonl"));
			expect(sessionFiles).toHaveLength(1);
			expect(await readFile(sessionFiles[0] ?? "", "utf8")).toContain('"type":"compaction"');
		},
	);

	it("does not hide retries after endpoint errors", async () => {
		const root = await temporaryDirectory("senko-error-");
		const cwd = join(root, "workspace");
		await mkdir(cwd);
		const server = await startServer("openai-responses", "error");
		const result = await runCli({
			args: ["--print", "fail once", "--api", "openai-responses", "--no-session"],
			cwd,
			env: runtimeEnvironment(server.baseUrl, root),
		});

		expect(result.code, result.stderr).toBe(1);
		expect(result.stderr).toContain("deterministic mock failure");
		expect(server.requests).toHaveLength(1);
	});

	it("persists, continues, resumes, and keeps secrets out of sessions", async () => {
		const root = await temporaryDirectory("senko-persistence-");
		const cwd = join(root, "workspace");
		await mkdir(cwd);
		const server = await startServer("openai-completions");
		const secret = "must-never-enter-a-session";
		const env = runtimeEnvironment(server.baseUrl, root, secret);

		const first = await runCli({ args: ["--print", "first session prompt"], cwd, env });
		expect(first.code, first.stderr).toBe(0);
		const sessionsDirectory = join(root, "state", "senko", "sessions");
		const initialSessionFiles = (await filesBelow(sessionsDirectory)).filter((path) => path.endsWith(".jsonl"));
		expect(initialSessionFiles).toHaveLength(1);
		const sessionSource = await readFile(initialSessionFiles[0] ?? "", "utf8");
		const sessionId = (JSON.parse(sessionSource.split("\n")[0] ?? "{}") as { id?: string }).id;
		expect(sessionId).toBeTruthy();

		const continued = await runCli({ args: ["--continue", "--print", "second prompt"], cwd, env });
		expect(continued.code, continued.stderr).toBe(0);
		expect(JSON.stringify(server.requests.at(-1)?.body)).toContain("first session prompt");

		const resumed = await runCli({ args: ["--resume", sessionId ?? "", "--print", "third prompt"], cwd, env });
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(JSON.stringify(server.requests.at(-1)?.body)).toContain("second prompt");

		const sessionFiles = await filesBelow(sessionsDirectory);
		expect(sessionFiles.some((path) => path.endsWith(".jsonl"))).toBe(true);
		for (const path of sessionFiles) {
			expect(await readFile(path, "utf8")).not.toContain(secret);
		}
	});
});
