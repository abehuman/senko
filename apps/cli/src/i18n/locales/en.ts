import type { Formatters } from "../types.js";

export function createEnglishMessages(formatters: Formatters) {
	return {
		apiEmpty: () => "API cannot be empty.",
		apiKeyRequired: () => "SENKO_API_KEY is required for non-loopback inference endpoints.",
		apiUnsupported: () => 'SENKO_API/--api must be "openai-completions" or "openai-responses".',
		autoCompactedAfter: ({ after, before }: { after: number; before: number }) =>
			`Context auto-compacted: ${formatters.number(before)} → ~${formatters.number(after)} tokens.`,
		autoCompactedBefore: ({ before }: { before: number }) =>
			`Context auto-compacted (${formatters.number(before)} tokens before).`,
		autoCompactionCancelled: () => "Auto-compaction cancelled.",
		autoCompactionFailed: () => "Auto-compaction failed.",
		autoCompactionFailedWithDetail: ({ message }: { message: string }) => `Auto-compaction failed: ${message}`,
		autoCompactionOverflow: () => "Context limit reached; auto-compacting before retry…",
		autoCompactionThreshold: () => "Auto-compacting context before the limit…",
		baseUrlAbsolute: () => "The configured base URL must be an absolute HTTP or HTTPS URL.",
		baseUrlHttp: () => "The configured base URL must use HTTP or HTTPS.",
		baseUrlParts: () => "The configured base URL cannot contain credentials, a query, or a fragment.",
		cliUnexpectedError: ({ message }: { message: string }) => `senko: unexpected error: ${message}`,
		cliUsageHint: () => "Run 'senko --help' for usage.",
		commandCompactDescription: () => "Compact the current session context",
		commandExitDescription: () => "Exit Senko",
		commandModelDescription: () => "Change model and effort",
		commandNewDescription: () => "Start a new session",
		commandPlanDescription: () => "Switch between edit and plan mode",
		commandResumeDescription: () => "Resume a saved session",
		commandUsage: ({ command }: { command: string }) => `Usage: ${command}`,
		compactedAfter: ({ after, before }: { after: number; before: number }) =>
			`Context compacted: ${formatters.number(before)} → ~${formatters.number(after)} tokens.`,
		compactedBefore: ({ before }: { before: number }) =>
			`Context compacted (${formatters.number(before)} tokens before).`,
		compactingContext: () => "Compacting context…",
		compactionCancelled: () => "Compaction cancelled.",
		compactionFailed: ({ message }: { message: string }) => `Compaction failed: ${message}`,
		configBoolean: ({ field, path }: { field: string; path: string }) =>
			`Configuration field "${field}" at ${path} must be a boolean.`,
		configContextWindow: ({ path, tokens }: { path: string; tokens: number }) =>
			`contextWindow must be greater than maxOutputTokens plus ${formatters.number(tokens)} safety tokens in ${path}.`,
		configNoApiKeys: ({ path }: { path: string }) => `API keys are not allowed in ${path}; use SENKO_API_KEY.`,
		configNotObject: ({ path }: { path: string }) => `Configuration at ${path} must contain a JSON object.`,
		configParse: ({ path }: { path: string }) => `Could not parse configuration at ${path}.`,
		configPositiveInteger: ({ field, path }: { field: string; path: string }) =>
			`Configuration field "${field}" at ${path} must be a positive integer.`,
		configRead: ({ path }: { path: string }) => `Could not read configuration at ${path}.`,
		configString: ({ field, path }: { field: string; path: string }) =>
			`Configuration field "${field}" at ${path} must be a string.`,
		configUnknownField: ({ field, path }: { field: string; path: string }) =>
			`Unknown configuration field "${field}" at ${path}.`,
		configValueEmpty: ({ name }: { name: string }) => `${name} cannot be empty.`,
		contextStillTooLarge: () =>
			"Context was compacted, but the pending prompt still exceeds the safe context budget. Shorten the prompt or configure a larger contextWindow.",
		diagnosticCollision: () => "collision",
		diagnosticError: () => "error",
		diagnosticWarning: () => "warning",
		featureNotBuilt: () => "This feature is not built yet.",
		footerCompacting: ({ model, session }: { model: string; session: string }) =>
			`compacting · Esc/Ctrl+C abort · ${model} · ${session}`,
		footerWorking: ({ model, session }: { model: string; session: string }) =>
			`working · Esc/Ctrl+C abort · ${model} · ${session}`,
		headerTagline: () => "fast coding agent",
		helpText: () => `Senko — fast terminal coding agent

Usage:
  senko [options] [initial prompt]
  senko sessions

Options:
  -p, --print                 Print one response and exit
  -c, --continue              Continue the newest session for this directory
  -r, --resume <session-id>   Resume a session by ID or unique ID prefix
      --no-session            Keep the session in memory only
      --base-url <url>        API root (default: https://api.senkocode.com/v1)
      --model <id>            Model ID (default: fast)
      --api <protocol>        openai-completions or openai-responses
      --language <locale>     Interface language: en, zh-CN, zh-TW, or ja
  -h, --help                  Show help
  -v, --version               Show version

Environment:
  SENKO_BASE_URL              API root override
  SENKO_API_KEY               Bearer key; required except for loopback endpoints
  SENKO_API                   API protocol (default: openai-completions)
  SENKO_LANGUAGE              Interface language; otherwise detected from the terminal locale

Safety:
  Senko runs read, write, edit, and shell tools automatically without a sandbox.
`,
		inferenceFailed: () => "Inference request failed.",
		interactiveTtyRequired: () => "Interactive mode requires a TTY; use --print for redirected output.",
		labelError: () => "error",
		labelThinking: () => "thinking",
		labelThinkingActive: () => "thinking…",
		labelTool: () => "tool",
		labelYou: () => "you",
		languageUnsupported: ({ value }: { value: string }) =>
			`Unsupported language "${value}". Use en, zh-CN, zh-TW, or ja.`,
		listSessionsFailed: ({ message }: { message: string }) => `Could not list saved sessions: ${message}`,
		maxOutputTokensMinimum: ({ path }: { path: string }) => `maxOutputTokens must be at least 2 in ${path}.`,
		modelRegistrationFailed: ({ model }: { model: string }) => `Could not register model "${model}".`,
		newSessionFailed: ({ message }: { message: string }) => `senko: could not start a new session: ${message}`,
		noSavedSessions: () => "No saved sessions for this directory.",
		printPromptRequired: () => "Print mode requires a prompt or non-empty piped stdin.",
		resumeDisabledNoSession: () => "Saved-session resume is disabled with --no-session.",
		resumeHint: () => "↑/↓ select · Enter resume · Esc cancel",
		resumeSelectedFailed: ({ message }: { message: string }) =>
			`senko: could not resume the selected session: ${message}`,
		resumeTitle: () => "Resume session",
		retryingRequest: () => "Retrying the request.",
		sessionAmbiguous: ({ id }: { id: string }) => `Session prefix "${id}" is ambiguous; provide more characters.`,
		sessionEmpty: () => "(empty session)",
		sessionMessages: ({ count }: { count: number }) => `${count} ${count === 1 ? "message" : "messages"}`,
		sessionNotFound: ({ cwd, id }: { cwd: string; id: string }) => `No session matching "${id}" exists for ${cwd}.`,
		sessionsNone: () => "No sessions for this directory.",
		toolFailed: () => "tool failed",
		toolFinished: () => "tool finished",
		usageContinueResume: () => "--continue and --resume cannot be used together.",
		usageMissingOptionValue: ({ option }: { option: string }) => `Option "${option}" requires a value.`,
		usageNoSessionResume: () => "--no-session cannot be combined with --continue or --resume.",
		usageOptionTakesNoValue: ({ option }: { option: string }) => `Option "${option}" does not accept a value.`,
		usageSessionOptions: () => "Session run options cannot be used with the sessions command.",
		usageSessionsPositionals: () => "The sessions command does not accept positional arguments.",
		usageUnknownOption: ({ option }: { option: string }) => `Unknown option "${option}".`,
	};
}

export type Messages = ReturnType<typeof createEnglishMessages>;
