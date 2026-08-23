import {
	API_PROTOCOLS,
	type ApiProtocol,
	type CloudflareBindings,
	type ModelCatalog,
	type ModelDefinition,
} from "./types";

export type ConfigResult<T> = { ok: true; value: T } | { message: string; ok: false };

interface LlmApiConfig {
	apiKey: string;
	baseUrl: string;
}

let cachedCatalogKey: string | undefined;
let cachedCatalog: ConfigResult<ModelCatalog> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const values = value.map(readString);
	return values.every((item): item is string => item !== undefined) ? [...new Set(values)] : undefined;
}

function readProtocols(value: unknown): ApiProtocol[] | undefined {
	const protocols = readStringArray(value);
	if (!protocols || protocols.some((protocol) => !API_PROTOCOLS.includes(protocol as ApiProtocol))) {
		return undefined;
	}
	return protocols as ApiProtocol[];
}

function parseModel(value: unknown, index: number): ConfigResult<ModelDefinition> {
	if (!isRecord(value)) {
		return { message: `SENKO_MODELS[${index}] must be an object.`, ok: false };
	}

	const id = readString(value.id);
	const contextWindow = readPositiveInteger(value.context_window);
	const maxOutputTokens = readPositiveInteger(value.max_output_tokens);
	const supportedProtocols = readProtocols(value.supported_protocols);
	const inputModalities = readStringArray(value.input_modalities);
	const created = value.created === undefined ? 0 : readNonNegativeInteger(value.created);
	const ownedBy = value.owned_by === undefined ? "senko" : readString(value.owned_by);

	if (!id || !contextWindow || !maxOutputTokens || !supportedProtocols || !inputModalities) {
		return {
			message:
				`SENKO_MODELS[${index}] requires id, positive context_window and max_output_tokens, ` +
				"supported_protocols, and input_modalities.",
			ok: false,
		};
	}
	if (created === undefined || !ownedBy || typeof value.reasoning !== "boolean") {
		return {
			message: `SENKO_MODELS[${index}] has an invalid created, owned_by, or reasoning value.`,
			ok: false,
		};
	}
	if (maxOutputTokens >= contextWindow) {
		return { message: `SENKO_MODELS[${index}].max_output_tokens must be less than context_window.`, ok: false };
	}

	return {
		ok: true,
		value: {
			context_window: contextWindow,
			created,
			id,
			input_modalities: inputModalities,
			max_output_tokens: maxOutputTokens,
			owned_by: ownedBy,
			reasoning: value.reasoning,
			supported_protocols: supportedProtocols,
		},
	};
}

function parseCatalog(rawModels: string | undefined, fastModel: string | undefined): ConfigResult<ModelCatalog> {
	if (!rawModels?.trim() || !fastModel?.trim()) {
		return {
			message: "Set SENKO_MODELS and SENKO_FAST_MODEL in the Worker environment before serving inference requests.",
			ok: false,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawModels);
	} catch {
		return { message: "SENKO_MODELS must be a valid JSON array of model definitions.", ok: false };
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return { message: "SENKO_MODELS must contain at least one model definition.", ok: false };
	}

	const models: ModelDefinition[] = [];
	const byId = new Map<string, ModelDefinition>();
	for (const [index, value] of parsed.entries()) {
		const result = parseModel(value, index);
		if (!result.ok) {
			return result;
		}
		if (result.value.id === "fast") {
			return { message: 'SENKO_MODELS cannot use the reserved model ID "fast".', ok: false };
		}
		if (byId.has(result.value.id)) {
			return { message: `SENKO_MODELS contains duplicate model ID "${result.value.id}".`, ok: false };
		}
		models.push(result.value);
		byId.set(result.value.id, result.value);
	}

	const resolvedFastModel = byId.get(fastModel.trim());
	if (!resolvedFastModel) {
		return { message: "SENKO_FAST_MODEL must match an ID in SENKO_MODELS.", ok: false };
	}
	return { ok: true, value: { byId, fast: resolvedFastModel, models } };
}

export function getModelCatalog(env: CloudflareBindings): ConfigResult<ModelCatalog> {
	const cacheKey = `${env.SENKO_FAST_MODEL ?? ""}\0${env.SENKO_MODELS ?? ""}`;
	if (cacheKey !== cachedCatalogKey || !cachedCatalog) {
		cachedCatalogKey = cacheKey;
		cachedCatalog = parseCatalog(env.SENKO_MODELS, env.SENKO_FAST_MODEL);
	}
	return cachedCatalog;
}

export function getLlmApiConfig(env: CloudflareBindings): ConfigResult<LlmApiConfig> {
	const apiKey = env.LLM_API_KEY?.trim();
	const rawBaseUrl = env.LLM_API_BASE_URL?.trim();
	if (!apiKey || !rawBaseUrl) {
		return {
			message: "Set LLM_API_BASE_URL and the LLM_API_KEY Worker secret before serving inference requests.",
			ok: false,
		};
	}

	let url: URL;
	try {
		url = new URL(rawBaseUrl);
	} catch {
		return { message: "LLM_API_BASE_URL must be a valid absolute HTTPS URL.", ok: false };
	}
	if (url.protocol !== "https:") {
		return { message: "LLM_API_BASE_URL must use HTTPS.", ok: false };
	}
	if (url.username || url.password || url.search || url.hash) {
		return { message: "LLM_API_BASE_URL cannot contain credentials, a query string, or a fragment.", ok: false };
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return { ok: true, value: { apiKey, baseUrl: url.toString().replace(/\/$/, "") } };
}
