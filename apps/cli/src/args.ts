import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";
import { defaultI18n, type I18n, type Locale, normalizeLocale } from "./i18n/index.js";

export type SenkoApi = "openai-completions" | "openai-responses";

export interface CliArgs {
	api?: string;
	baseUrl?: string;
	command: "run" | "sessions";
	continueSession: boolean;
	help: boolean;
	language?: Locale;
	model?: string;
	noSession: boolean;
	print: boolean;
	prompt?: string;
	resumeId?: string;
	version: boolean;
}

function localizedParseError(error: unknown, i18n: I18n): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = (error as NodeJS.ErrnoException).code;
	const option = error.message.match(/'([^']+)'/)?.[1];
	if (!option) return undefined;
	if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
		return i18n.t("usageUnknownOption", { option });
	}
	if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
		return error.message.includes("argument missing")
			? i18n.t("usageMissingOptionValue", { option })
			: i18n.t("usageOptionTakesNoValue", { option });
	}
	return undefined;
}

export function parseCliArgs(argv: string[], i18n: I18n = defaultI18n): CliArgs {
	try {
		const parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				api: { type: "string" },
				"base-url": { type: "string" },
				continue: { type: "boolean", short: "c", default: false },
				help: { type: "boolean", short: "h", default: false },
				language: { type: "string" },
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
				throw new UsageError(i18n.t("usageSessionsPositionals"));
			}
		}

		const continueSession = parsed.values.continue ?? false;
		const resumeId = parsed.values.resume;
		const noSession = parsed.values["no-session"] ?? false;
		if (continueSession && resumeId) {
			throw new UsageError(i18n.t("usageContinueResume"));
		}
		if (noSession && (continueSession || resumeId)) {
			throw new UsageError(i18n.t("usageNoSessionResume"));
		}
		if (command === "sessions" && (continueSession || resumeId || noSession || parsed.values.print)) {
			throw new UsageError(i18n.t("usageSessionOptions"));
		}
		const rawLanguage = parsed.values.language;
		const language = normalizeLocale(rawLanguage);
		if (rawLanguage !== undefined && language === undefined) {
			throw new UsageError(i18n.t("languageUnsupported", { value: rawLanguage }));
		}

		return {
			api: parsed.values.api,
			baseUrl: parsed.values["base-url"],
			command,
			continueSession,
			help: parsed.values.help ?? false,
			language,
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
		throw new UsageError(localizedParseError(error, i18n) ?? message, { cause: error });
	}
}

export function helpText(i18n: I18n = defaultI18n): string {
	return i18n.t("helpText");
}

export const HELP_TEXT = helpText();
