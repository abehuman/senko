import { readFile } from "node:fs/promises";
import type { CliArgs, SenkoApi } from "./args.js";
import { PI_CONTEXT_SAFETY_TOKENS } from "./auto-compact.js";
import { SenkoError } from "./errors.js";
import { defaultI18n, type I18n, type Locale, normalizeLocale } from "./i18n/index.js";
import { getConfigPath } from "./paths.js";

const ALLOWED_KEYS = new Set(["api", "baseUrl", "contextWindow", "language", "maxOutputTokens", "model", "reasoning"]);

interface FileConfig {
	api?: SenkoApi;
	baseUrl?: string;
	contextWindow?: number;
	language?: string;
	maxOutputTokens?: number;
	model?: string;
	reasoning?: boolean;
}

export interface RuntimeConfig {
	api: SenkoApi;
	apiKey?: string;
	baseUrl: string;
	configPath: string;
	contextWindow: number;
	isLoopback: boolean;
	language: Locale;
	maxOutputTokens: number;
	model: string;
	reasoning: boolean;
}

export interface ResolveConfigOptions {
	args: Pick<CliArgs, "api" | "baseUrl" | "language" | "model">;
	configPath?: string;
	env?: NodeJS.ProcessEnv;
	i18n?: I18n;
}

function ensureObject(value: unknown, path: string, i18n: I18n): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SenkoError(i18n.t("configNotObject", { path }));
	}
	return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string, path: string, i18n: I18n): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new SenkoError(i18n.t("configPositiveInteger", { field, path }));
	}
	return value as number;
}

export function parseConfigFile(source: string, path: string, i18n: I18n = defaultI18n): FileConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new SenkoError(i18n.t("configParse", { path }), 1, { cause: error });
	}

	const record = ensureObject(parsed, path, i18n);
	if ("apiKey" in record || "key" in record) {
		throw new SenkoError(i18n.t("configNoApiKeys", { path }));
	}
	for (const key of Object.keys(record)) {
		if (!ALLOWED_KEYS.has(key)) {
			throw new SenkoError(i18n.t("configUnknownField", { field: key, path }));
		}
	}

	for (const field of ["api", "baseUrl", "language", "model"] as const) {
		if (record[field] !== undefined && typeof record[field] !== "string") {
			throw new SenkoError(i18n.t("configString", { field, path }));
		}
	}
	if (record.reasoning !== undefined && typeof record.reasoning !== "boolean") {
		throw new SenkoError(i18n.t("configBoolean", { field: "reasoning", path }));
	}

	return {
		api: record.api as SenkoApi | undefined,
		baseUrl: record.baseUrl as string | undefined,
		contextWindow: positiveInteger(record.contextWindow, "contextWindow", path, i18n),
		language: record.language as string | undefined,
		maxOutputTokens: positiveInteger(record.maxOutputTokens, "maxOutputTokens", path, i18n),
		model: record.model as string | undefined,
		reasoning: record.reasoning as boolean | undefined,
	};
}

async function loadConfigFile(path: string, i18n: I18n): Promise<FileConfig> {
	try {
		return parseConfigFile(await readFile(path, "utf8"), path, i18n);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		if (error instanceof SenkoError) {
			throw error;
		}
		throw new SenkoError(i18n.t("configRead", { path }), 1, { cause: error });
	}
}

export function normalizeBaseUrl(value: string, i18n: I18n = defaultI18n): { baseUrl: string; isLoopback: boolean } {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new SenkoError(i18n.t("baseUrlAbsolute"), 1, { cause: error });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SenkoError(i18n.t("baseUrlHttp"));
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new SenkoError(i18n.t("baseUrlParts"));
	}

	const hostname = url.hostname.toLowerCase();
	const isLoopback =
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.startsWith("127.") ||
		hostname === "::1" ||
		hostname === "[::1]";
	return { baseUrl: url.toString().replace(/\/$/, ""), isLoopback };
}

function nonEmpty(value: string | undefined, name: string, i18n: I18n): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new SenkoError(i18n.t("configValueEmpty", { name }));
	}
	return trimmed;
}

function parseApi(value: string, i18n: I18n): SenkoApi {
	if (value === "openai-completions" || value === "openai-responses") {
		return value;
	}
	throw new SenkoError(i18n.t("apiUnsupported"));
}

export async function resolveConfig(options: ResolveConfigOptions): Promise<RuntimeConfig> {
	const env = options.env ?? process.env;
	const i18n = options.i18n ?? defaultI18n;
	const configPath = options.configPath ?? getConfigPath(env);
	const file = await loadConfigFile(configPath, i18n);
	const rawBaseUrl = nonEmpty(options.args.baseUrl ?? env.SENKO_BASE_URL ?? file.baseUrl, "Base URL", i18n);
	if (!rawBaseUrl) {
		throw new SenkoError(i18n.t("inferenceEndpointMissing", { path: configPath }));
	}
	const { baseUrl, isLoopback } = normalizeBaseUrl(rawBaseUrl, i18n);
	const model = nonEmpty(options.args.model ?? env.SENKO_MODEL ?? file.model ?? "fast", "Model", i18n) ?? "fast";
	const rawApi = nonEmpty(options.args.api ?? env.SENKO_API ?? file.api ?? "openai-completions", "API", i18n);
	if (!rawApi) {
		throw new SenkoError(i18n.t("apiEmpty"));
	}
	const api = parseApi(rawApi, i18n);
	const apiKey = nonEmpty(env.SENKO_API_KEY, "SENKO_API_KEY", i18n);
	if (!isLoopback && !apiKey) {
		throw new SenkoError(i18n.t("apiKeyRequired"));
	}
	const rawLanguage = options.args.language ?? env.SENKO_LANGUAGE ?? file.language;
	const language = rawLanguage === undefined ? i18n.locale : normalizeLocale(rawLanguage);
	if (!language) {
		throw new SenkoError(i18n.t("languageUnsupported", { value: rawLanguage ?? "" }));
	}
	const contextWindow = file.contextWindow ?? 32_768;
	const maxOutputTokens = file.maxOutputTokens ?? 4_096;
	if (maxOutputTokens < 2) {
		throw new SenkoError(i18n.t("maxOutputTokensMinimum", { path: configPath }));
	}
	if (maxOutputTokens + PI_CONTEXT_SAFETY_TOKENS >= contextWindow) {
		throw new SenkoError(i18n.t("configContextWindow", { path: configPath, tokens: PI_CONTEXT_SAFETY_TOKENS }));
	}

	return {
		api,
		apiKey,
		baseUrl,
		configPath,
		contextWindow,
		isLoopback,
		language,
		maxOutputTokens,
		model,
		reasoning: file.reasoning ?? false,
	};
}
