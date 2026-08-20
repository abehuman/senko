import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export type SenkoApi = "openai-completions" | "openai-responses";

export interface CliArgs {
	api?: string;
	baseUrl?: string;
	command: "run" | "sessions";
	continueSession: boolean;
	help: boolean;
	model?: string;
	noSession: boolean;
	print: boolean;
	prompt?: string;
	resumeId?: string;
	version: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
	try {
		const parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				api: { type: "string" },
				"base-url": { type: "string" },
				continue: { type: "boolean", short: "c", default: false },
				help: { type: "boolean", short: "h", default: false },
				model: { type: "string" },
				"no-session": { type: "boolean", default: false },
				print: { type: "boolean", short: "p", default: false },
				resume: { type: "string", short: "r" },
				version: { type: "boolean", short: "v", default: false },
			},
			strict: true,
		});

		const positionals = [...parsed.positionals];
		const command = positionals[0] === "sessions" ? "sessions" : "run";
		if (command === "sessions") {
			positionals.shift();
			if (positionals.length > 0) {
				throw new UsageError("The sessions command does not accept positional arguments.");
			}
		}

		const continueSession = parsed.values.continue ?? false;
		const resumeId = parsed.values.resume;
		const noSession = parsed.values["no-session"] ?? false;
		if (continueSession && resumeId) {
			throw new UsageError("--continue and --resume cannot be used together.");
		}
		if (noSession && (continueSession || resumeId)) {
			throw new UsageError("--no-session cannot be combined with --continue or --resume.");
		}
		if (command === "sessions" && (continueSession || resumeId || noSession || parsed.values.print)) {
			throw new UsageError("Session run options cannot be used with the sessions command.");
		}

		return {
			api: parsed.values.api,
			baseUrl: parsed.values["base-url"],
			command,
			continueSession,
			help: parsed.values.help ?? false,
			model: parsed.values.model,
			noSession,
			print: parsed.values.print ?? false,
			prompt: command === "run" && positionals.length > 0 ? positionals.join(" ") : undefined,
			resumeId,
			version: parsed.values.version ?? false,
		};
	} catch (error) {
		if (error instanceof UsageError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new UsageError(message, { cause: error });
	}
}

export const HELP_TEXT = `Senko — fast terminal coding agent

Usage:
  senko [options] [initial prompt]
  senko sessions

Options:
  -p, --print                 Print one response and exit
  -c, --continue              Continue the newest session for this directory
  -r, --resume <session-id>   Resume a session by ID or unique ID prefix
      --no-session            Keep the session in memory only
      --base-url <url>        OpenAI-compatible API root (normally ends in /v1)
      --model <id>            Model ID (default: fast)
      --api <protocol>        openai-completions or openai-responses
  -h, --help                  Show help
  -v, --version               Show version

Environment:
  SENKO_BASE_URL              API root; required until Senko's service launches
  SENKO_API_KEY               Bearer key; required except for loopback endpoints
  SENKO_MODEL                 Model ID
  SENKO_API                   API protocol (default: openai-completions)

Safety:
  Senko runs read, write, edit, and shell tools automatically without a sandbox.
`;
