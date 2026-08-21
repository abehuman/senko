import { readFile } from "node:fs/promises";
import type { CliArgs, SenkoApi } from "./args.js";
import { PI_CONTEXT_SAFETY_TOKENS } from "./auto-compact.js";
import { SenkoError } from "./errors.js";
import { getConfigPath } from "./paths.js";

const ALLOWED_KEYS = new Set(["api", "baseUrl", "contextWindow", "maxOutputTokens", "model", "reasoning"]);

interface FileConfig {
	api?: SenkoApi;
	baseUrl?: string;
	contextWindow?: number;
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
	maxOutputTokens: number;
	model: string;
	reasoning: boolean;
}

export interface ResolveConfigOptions {
	args: Pick<CliArgs, "api" | "baseUrl" | "model">;
	configPath?: string;
	env?: NodeJS.ProcessEnv;
}

function ensureObject(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SenkoError(`Configuration at ${path} must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string, path: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new SenkoError(`Configuration field "${field}" at ${path} must be a positive integer.`);
	}
	return value as number;
}

export function parseConfigFile(source: string, path: string): FileConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new SenkoError(`Could not parse configuration at ${path}.`, 1, { cause: error });
	}

	const record = ensureObject(parsed, path);
	if ("apiKey" in record || "key" in record) {
		throw new SenkoError(`API keys are not allowed in ${path}; use SENKO_API_KEY.`);
	}
	for (const key of Object.keys(record)) {
		if (!ALLOWED_KEYS.has(key)) {
			throw new SenkoError(`Unknown configuration field "${key}" at ${path}.`);
		}
	}

	for (const field of ["api", "baseUrl", "model"] as const) {
		if (record[field] !== undefined && typeof record[field] !== "string") {
			throw new SenkoError(`Configuration field "${field}" at ${path} must be a string.`);
		}
	}
	if (record.reasoning !== undefined && typeof record.reasoning !== "boolean") {
		throw new SenkoError(`Configuration field "reasoning" at ${path} must be a boolean.`);
	}

	return {
		api: record.api as SenkoApi | undefined,
		baseUrl: record.baseUrl as string | undefined,
		contextWindow: positiveInteger(record.contextWindow, "contextWindow", path),
		maxOutputTokens: positiveInteger(record.maxOutputTokens, "maxOutputTokens", path),
		model: record.model as string | undefined,
		reasoning: record.reasoning as boolean | undefined,
	};
}

async function loadConfigFile(path: string): Promise<FileConfig> {
	try {
		return parseConfigFile(await readFile(path, "utf8"), path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		if (error instanceof SenkoError) {
			throw error;
		}
		throw new SenkoError(`Could not read configuration at ${path}.`, 1, { cause: error });
	}
}

export function normalizeBaseUrl(value: string): { baseUrl: string; isLoopback: boolean } {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new SenkoError("The configured base URL must be an absolute HTTP or HTTPS URL.", 1, { cause: error });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SenkoError("The configured base URL must use HTTP or HTTPS.");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new SenkoError("The configured base URL cannot contain credentials, a query, or a fragment.");
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

function nonEmpty(value: string | undefined, name: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new SenkoError(`${name} cannot be empty.`);
	}
	return trimmed;
}

function parseApi(value: string): SenkoApi {
	if (value === "openai-completions" || value === "openai-responses") {
		return value;
	}
	throw new SenkoError('SENKO_API/--api must be "openai-completions" or "openai-responses".');
}

export async function resolveConfig(options: ResolveConfigOptions): Promise<RuntimeConfig> {
	const env = options.env ?? process.env;
	const configPath = options.configPath ?? getConfigPath(env);
	const file = await loadConfigFile(configPath);
	const rawBaseUrl = nonEmpty(options.args.baseUrl ?? env.SENKO_BASE_URL ?? file.baseUrl, "Base URL");
	if (!rawBaseUrl) {
		throw new SenkoError(
			`No inference endpoint is configured. Set SENKO_BASE_URL, pass --base-url, or add baseUrl to ${configPath}.`,
		);
	}
	const { baseUrl, isLoopback } = normalizeBaseUrl(rawBaseUrl);
	const model = nonEmpty(options.args.model ?? env.SENKO_MODEL ?? file.model ?? "fast", "Model") ?? "fast";
	const rawApi = nonEmpty(options.args.api ?? env.SENKO_API ?? file.api ?? "openai-completions", "API");
	if (!rawApi) {
		throw new SenkoError("API cannot be empty.");
	}
	const api = parseApi(rawApi);
	const apiKey = nonEmpty(env.SENKO_API_KEY, "SENKO_API_KEY");
	if (!isLoopback && !apiKey) {
		throw new SenkoError("SENKO_API_KEY is required for non-loopback inference endpoints.");
	}
	const contextWindow = file.contextWindow ?? 32_768;
	const maxOutputTokens = file.maxOutputTokens ?? 4_096;
	if (maxOutputTokens < 2) {
		throw new SenkoError(`maxOutputTokens must be at least 2 in ${configPath}.`);
	}
	if (maxOutputTokens + PI_CONTEXT_SAFETY_TOKENS >= contextWindow) {
		throw new SenkoError(
			`contextWindow must be greater than maxOutputTokens plus ${PI_CONTEXT_SAFETY_TOKENS.toLocaleString("en-US")} safety tokens in ${configPath}.`,
		);
	}

	return {
		api,
		apiKey,
		baseUrl,
		configPath,
		contextWindow,
		isLoopback,
		maxOutputTokens,
		model,
		reasoning: file.reasoning ?? false,
	};
}
