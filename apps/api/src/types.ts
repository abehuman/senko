import type { ApiKeyScope } from "./db/schema";
import type { FailureCategory } from "./observability";
import type { ProviderPoolCapacity } from "./provider-pool-state";

export const API_PROTOCOLS = ["openai-completions", "openai-responses"] as const;

export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export interface CloudflareBindings {
	[key: string]: unknown;
	SENKO_ADMISSION?: DurableObjectNamespace;
	SENKO_ADMIN_TOKEN?: string;
	SENKO_API_KEYS?: string;
	SENKO_API_KEY_HASH_SECRET_V1?: string;
	SENKO_AUTH_MODE?: string;
	SENKO_DATABASE_URL?: string;
	SENKO_FAST_MODEL?: string;
	SENKO_INFERENCE_ENABLED?: string;
	SENKO_MODELS?: string;
	SENKO_PROVIDER_KEY_DEEPSEEK?: string;
	SENKO_PROVIDER_KEY_OPENAI?: string;
	SENKO_PROVIDER_KEY_OPENROUTER?: string;
	SENKO_PROVIDER_POOLS?: DurableObjectNamespace;
	SENKO_PROVIDER_ROUTES?: string;
	LLM_API_BASE_URL?: string;
	LLM_API_KEY?: string;
}

export interface AppVariables {
	accountId?: string;
	apiKeyId: string;
	apiKeyScopes: ApiKeyScope[];
	failureCategory?: FailureCategory;
	requestId: string;
	requestCompletionDeferred?: boolean;
	requestStartedAt: number;
	requestStartedAtDate: Date;
}

export interface AppEnv {
	Bindings: CloudflareBindings;
	Variables: AppVariables;
}

export interface ModelDefinition {
	context_window: number;
	created: number;
	id: string;
	input_modalities: string[];
	max_output_tokens: number;
	owned_by: string;
	pricing?: ModelPricing;
	reasoning: boolean;
	supported_protocols: ApiProtocol[];
}

export interface ModelPricing {
	currency: string;
	input_microunits_per_million_tokens: number;
	output_microunits_per_million_tokens: number;
	version: string;
}

export interface ModelCatalog {
	byId: Map<string, ModelDefinition>;
	fast: ModelDefinition;
	models: ModelDefinition[];
}

export interface ProviderRoute {
	apiKey: string;
	baseUrl: string;
	capacity?: ProviderPoolCapacity;
	id: string;
	priority: number;
	providerModel: string;
}

export type LlmApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
