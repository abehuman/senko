import { homedir } from "node:os";
import type { CliArgs } from "./args.js";
import { resolveConfig } from "./config.js";
import { SenkoError } from "./errors.js";
import { createI18n, defaultI18n, type I18n } from "./i18n/index.js";
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
	i18n?: I18n;
	stdin?: string;
	stdoutIsTty?: boolean;
}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const bootstrapI18n = options.i18n ?? defaultI18n;
	const sessionsDir = getSessionsDir(env, home);
	if (options.args.command === "sessions") {
		const { formatSessions, listSessions } = await import("./sessions.js");
		process.stdout.write(`${formatSessions(await listSessions(cwd, sessionsDir), bootstrapI18n)}\n`);
		return 0;
	}

	const prompt = combinePrompt(options.args.prompt, options.stdin);
	const printMode = options.args.print || options.stdin !== undefined;
	if (printMode && !prompt) {
		throw new SenkoError(bootstrapI18n.t("printPromptRequired"), 2);
	}
	if (!printMode && options.stdoutIsTty === false) {
		throw new SenkoError(bootstrapI18n.t("interactiveTtyRequired"), 2);
	}

	const config = await resolveConfig({
		args: options.args,
		configPath: getConfigPath(env, home),
		env,
		i18n: bootstrapI18n,
	});
	const i18n = config.language === bootstrapI18n.locale ? bootstrapI18n : createI18n(config.language);
	const { selectSessionManager } = await import("./sessions.js");
	const sessionManager = await selectSessionManager({ args: options.args, cwd, sessionsDir }, i18n);
	const { createRuntime } = await import("./runtime.js");
	const runtime = await createRuntime({ config, cwd, home, i18n, sessionManager });
	printDiagnostics(runtime.diagnostics, process.stderr, i18n);
	try {
		if (printMode) {
			if (!prompt) {
				throw new SenkoError(i18n.t("printPromptRequired"), 2);
			}
			return await runPrintMode(runtime.sessionRuntime.session, prompt, config, undefined, i18n);
		}
		const { runInteractiveMode } = await import("./ui/interactive.js");
		return await runInteractiveMode({
			config,
			cwd,
			i18n,
			initialPrompt: prompt,
			sessionRuntime: runtime.sessionRuntime,
		});
	} finally {
		await runtime.sessionRuntime.dispose();
	}
}
