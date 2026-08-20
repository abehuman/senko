import { homedir } from "node:os";
import type { CliArgs } from "./args.js";
import { resolveConfig } from "./config.js";
import { SenkoError } from "./errors.js";
import { getConfigPath, getSessionsDir } from "./paths.js";
import { printDiagnostics, runPrintMode } from "./print.js";

function combinePrompt(positional: string | undefined, stdin: string | undefined): string | undefined {
	const input = stdin?.trim();
	if (positional && input) {
		return `${positional}\n\n${input}`;
	}
	return positional ?? input;
}

export async function runApp(options: {
	args: CliArgs;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	stdin?: string;
	stdoutIsTty?: boolean;
}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const sessionsDir = getSessionsDir(env, home);
	if (options.args.command === "sessions") {
		const { formatSessions, listSessions } = await import("./sessions.js");
		process.stdout.write(`${formatSessions(await listSessions(cwd, sessionsDir))}\n`);
		return 0;
	}

	const prompt = combinePrompt(options.args.prompt, options.stdin);
	const printMode = options.args.print || options.stdin !== undefined;
	if (printMode && !prompt) {
		throw new SenkoError("Print mode requires a prompt or non-empty piped stdin.", 2);
	}
	if (!printMode && options.stdoutIsTty === false) {
		throw new SenkoError("Interactive mode requires a TTY; use --print for redirected output.", 2);
	}

	const config = await resolveConfig({ args: options.args, configPath: getConfigPath(env, home), env });
	const { selectSessionManager } = await import("./sessions.js");
	const sessionManager = await selectSessionManager({ args: options.args, cwd, sessionsDir });
	const { createRuntime } = await import("./runtime.js");
	const runtime = await createRuntime({ config, cwd, home, sessionManager });
	printDiagnostics(runtime.diagnostics, process.stderr);
	try {
		if (printMode) {
			if (!prompt) {
				throw new SenkoError("Print mode requires a prompt or non-empty piped stdin.", 2);
			}
			return await runPrintMode(runtime.session, prompt);
		}
		const { runInteractiveMode } = await import("./ui/interactive.js");
		return await runInteractiveMode({ config, cwd, initialPrompt: prompt, session: runtime.session });
	} finally {
		runtime.session.dispose();
	}
}
