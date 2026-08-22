import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const builtCliPath = join(repositoryRoot, "apps", "cli", "dist", "cli.js");
const sourceCliPath = join(repositoryRoot, "apps", "cli", "src", "cli.ts");
const tsxLoader = join(repositoryRoot, "apps", "cli", "node_modules", "tsx", "dist", "loader.mjs");

export interface CliResult {
	code: number;
	stderr: string;
	stdout: string;
}

export async function runCli(options: {
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
	timeoutMs?: number;
}): Promise<CliResult> {
	const env = { ...process.env };
	for (const key of [
		"LANG",
		"LANGUAGE",
		"LC_ALL",
		"LC_MESSAGES",
		"SENKO_API",
		"SENKO_API_KEY",
		"SENKO_BASE_URL",
		"SENKO_LANGUAGE",
	]) {
		delete env[key];
	}
	Object.assign(env, { LANG: "en_US.UTF-8" }, options.env, { NO_COLOR: "1" });
	const commandArguments = existsSync(builtCliPath)
		? [builtCliPath, ...options.args]
		: ["--import", tsxLoader, sourceCliPath, ...options.args];

	return new Promise<CliResult>((resolve, reject) => {
		const child = spawn(process.execPath, commandArguments, {
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Senko CLI timed out after ${options.timeoutMs ?? 15_000}ms`));
		}, options.timeoutMs ?? 15_000);
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ code: code ?? 1, stderr, stdout });
		});
		child.stdin.end(options.input ?? "");
	});
}
