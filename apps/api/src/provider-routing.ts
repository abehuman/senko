import { type ConfigResult, getLlmApiConfig } from "./config";
import type { ProviderPoolCapacity } from "./provider-pool-state";
import { API_PROTOCOLS, type ApiProtocol, type CloudflareBindings, type ProviderRoute } from "./types";

const MAX_PROVIDER_ROUTES = 32;
const MAX_MODELS_PER_ROUTE = 512;
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const TRUSTED_PROVIDER_DESTINATIONS = {
	deepseek: {
		apiKeyBinding: "SENKO_PROVIDER_KEY_DEEPSEEK",
		baseUrl: "https://api.deepseek.com",
	},
	openai: {
		apiKeyBinding: "SENKO_PROVIDER_KEY_OPENAI",
		baseUrl: "https://api.openai.com/v1",
	},
	openrouter: {
		apiKeyBinding: "SENKO_PROVIDER_KEY_OPENROUTER",
		baseUrl: "https://openrouter.ai/api/v1",
	},
} as const;

type TrustedProviderDestination = keyof typeof TRUSTED_PROVIDER_DESTINATIONS;

const ROUTE_FIELDS = new Set(["capacity", "destination", "id", "models", "priority", "supported_protocols"]);

interface ParsedProviderRoute {
	apiKeyBinding: string;
	baseUrl: string;
	capacity?: ProviderPoolCapacity;
	destination: TrustedProviderDestination | "legacy";
	id: string;
	models: Map<string, string>;
	priority: number;
	supportedProtocols: ApiProtocol[];
}

let cachedRawRoutes: string | undefined;
let cachedRoutes: ConfigResult<ParsedProviderRoute[]> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseProtocols(value: unknown, index: number): ConfigResult<ApiProtocol[]> {
	if (!Array.isArray(value) || value.length === 0) {
		return {
			message: `SENKO_PROVIDER_ROUTES[${index}].supported_protocols must be a non-empty protocol array.`,
			ok: false,
		};
	}
	const protocols = value.map(readString);
	if (protocols.some((protocol) => protocol === undefined || !API_PROTOCOLS.includes(protocol as ApiProtocol))) {
		return { message: `SENKO_PROVIDER_ROUTES[${index}].supported_protocols contains an unknown protocol.`, ok: false };
	}
	return { ok: true, value: [...new Set(protocols as ApiProtocol[])] };
}

function parseModels(value: unknown, index: number): ConfigResult<Map<string, string>> {
	if (!isRecord(value)) {
		return { message: `SENKO_PROVIDER_ROUTES[${index}].models must be an object.`, ok: false };
	}
	const entries = Object.entries(value);
	if (entries.length === 0 || entries.length > MAX_MODELS_PER_ROUTE) {
		return {
			message: `SENKO_PROVIDER_ROUTES[${index}].models must contain between 1 and ${MAX_MODELS_PER_ROUTE} entries.`,
			ok: false,
		};
	}
	const models = new Map<string, string>();
	for (const [model, providerModelValue] of entries) {
		const catalogModel = readString(model);
		const providerModel = readString(providerModelValue);
		if (!catalogModel || catalogModel.length > 256 || !providerModel || providerModel.length > 256) {
			return {
				message: `SENKO_PROVIDER_ROUTES[${index}].models must map non-empty model IDs of at most 256 characters.`,
				ok: false,
			};
		}
		models.set(catalogModel, providerModel);
	}
	return { ok: true, value: models };
}

function parseCapacity(value: unknown, index: number): ConfigResult<ProviderPoolCapacity> {
	if (!isRecord(value)) {
		return { message: `SENKO_PROVIDER_ROUTES[${index}].capacity must be an object.`, ok: false };
	}
	const fields = Object.keys(value);
	const expectedFields = ["max_concurrent_requests", "requests_per_minute", "tokens_per_minute"];
	if (fields.length !== expectedFields.length || fields.some((field) => !expectedFields.includes(field))) {
		return {
			message: `SENKO_PROVIDER_ROUTES[${index}].capacity must contain only ` + `${expectedFields.join(", ")}.`,
			ok: false,
		};
	}
	const maxConcurrentRequests = value.max_concurrent_requests;
	const requestsPerMinute = value.requests_per_minute;
	const tokensPerMinute = value.tokens_per_minute;
	if (
		typeof maxConcurrentRequests !== "number" ||
		!Number.isSafeInteger(maxConcurrentRequests) ||
		maxConcurrentRequests <= 0 ||
		typeof requestsPerMinute !== "number" ||
		!Number.isSafeInteger(requestsPerMinute) ||
		requestsPerMinute <= 0 ||
		typeof tokensPerMinute !== "number" ||
		!Number.isSafeInteger(tokensPerMinute) ||
		tokensPerMinute <= 0
	) {
		return {
			message: `SENKO_PROVIDER_ROUTES[${index}].capacity values must be positive safe integers.`,
			ok: false,
		};
	}
	return { ok: true, value: { maxConcurrentRequests, requestsPerMinute, tokensPerMinute } };
}

function parseRoute(value: unknown, index: number): ConfigResult<ParsedProviderRoute> {
	if (!isRecord(value)) {
		return { message: `SENKO_PROVIDER_ROUTES[${index}] must be an object.`, ok: false };
	}
	const unsupportedFields = Object.keys(value).filter((field) => !ROUTE_FIELDS.has(field));
	if (unsupportedFields.length > 0) {
		return {
			message: `SENKO_PROVIDER_ROUTES[${index}] contains unsupported fields: ${unsupportedFields.sort().join(", ")}.`,
			ok: false,
		};
	}
	const id = readString(value.id);
	const destination = readString(value.destination);
	const priority = value.priority;
	if (!id || !ROUTE_ID_PATTERN.test(id)) {
		return {
			message: `SENKO_PROVIDER_ROUTES[${index}].id must match ${ROUTE_ID_PATTERN.source}.`,
			ok: false,
		};
	}
	if (!destination || !(destination in TRUSTED_PROVIDER_DESTINATIONS)) {
		return {
			message:
				`SENKO_PROVIDER_ROUTES[${index}].destination must be one of: ` +
				`${Object.keys(TRUSTED_PROVIDER_DESTINATIONS).join(", ")}.`,
			ok: false,
		};
	}
	if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 0) {
		return { message: `SENKO_PROVIDER_ROUTES[${index}].priority must be a non-negative integer.`, ok: false };
	}
	const models = parseModels(value.models, index);
	if (!models.ok) return models;
	const capacity = parseCapacity(value.capacity, index);
	if (!capacity.ok) return capacity;
	const supportedProtocols = parseProtocols(value.supported_protocols, index);
	if (!supportedProtocols.ok) return supportedProtocols;
	const trustedDestination = destination as TrustedProviderDestination;
	const provider = TRUSTED_PROVIDER_DESTINATIONS[trustedDestination];
	return {
		ok: true,
		value: {
			apiKeyBinding: provider.apiKeyBinding,
			baseUrl: provider.baseUrl,
			capacity: capacity.value,
			destination: trustedDestination,
			id,
			models: models.value,
			priority,
			supportedProtocols: supportedProtocols.value,
		},
	};
}

function parseRoutes(rawRoutes: string): ConfigResult<ParsedProviderRoute[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawRoutes);
	} catch {
		return { message: "SENKO_PROVIDER_ROUTES must be a valid JSON array.", ok: false };
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_PROVIDER_ROUTES) {
		return {
			message: `SENKO_PROVIDER_ROUTES must contain between 1 and ${MAX_PROVIDER_ROUTES} route definitions.`,
			ok: false,
		};
	}
	const routes: ParsedProviderRoute[] = [];
	const ids = new Set<string>();
	for (const [index, value] of parsed.entries()) {
		const route = parseRoute(value, index);
		if (!route.ok) return route;
		if (ids.has(route.value.id)) {
			return { message: `SENKO_PROVIDER_ROUTES contains duplicate route ID "${route.value.id}".`, ok: false };
		}
		ids.add(route.value.id);
		routes.push(route.value);
	}
	return { ok: true, value: routes };
}

function configuredRoutes(env: CloudflareBindings): ConfigResult<ParsedProviderRoute[]> {
	const rawRoutes = env.SENKO_PROVIDER_ROUTES?.trim();
	if (!rawRoutes) {
		if (env.SENKO_AUTH_MODE?.trim() === "database") {
			return {
				message: "Configure SENKO_PROVIDER_ROUTES before serving database-authenticated inference requests.",
				ok: false,
			};
		}
		const legacy = getLlmApiConfig(env);
		if (!legacy.ok) return legacy;
		return {
			ok: true,
			value: [
				{
					apiKeyBinding: "LLM_API_KEY",
					baseUrl: legacy.value.baseUrl,
					destination: "legacy",
					id: "primary",
					models: new Map(),
					priority: 0,
					supportedProtocols: [...API_PROTOCOLS],
				},
			],
		};
	}
	if (cachedRawRoutes !== rawRoutes || !cachedRoutes) {
		cachedRawRoutes = rawRoutes;
		cachedRoutes = parseRoutes(rawRoutes);
	}
	return cachedRoutes;
}

export function getProviderRouteCandidates(
	env: CloudflareBindings,
	model: string,
	protocol: ApiProtocol,
): ConfigResult<ProviderRoute[]> {
	const configured = configuredRoutes(env);
	if (!configured.ok) return configured;
	const explicitRoutes = env.SENKO_PROVIDER_ROUTES?.trim() !== undefined && env.SENKO_PROVIDER_ROUTES.trim() !== "";
	const candidates: ProviderRoute[] = [];
	for (const route of configured.value) {
		if (!route.supportedProtocols.includes(protocol)) continue;
		const providerModel = explicitRoutes ? route.models.get(model) : model;
		if (!providerModel) continue;
		const apiKey = env[route.apiKeyBinding];
		if (typeof apiKey !== "string" || apiKey.trim() === "") {
			return {
				message: `Set the ${route.apiKeyBinding} Worker secret required by provider route "${route.id}".`,
				ok: false,
			};
		}
		candidates.push({
			apiKey: apiKey.trim(),
			baseUrl: route.baseUrl,
			capacity: route.capacity,
			id: route.id,
			priority: route.priority,
			providerModel,
		});
	}
	if (candidates.length === 0) {
		return {
			message: `Configure at least one provider route for model "${model}" and protocol "${protocol}".`,
			ok: false,
		};
	}
	candidates.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
	return { ok: true, value: candidates };
}
