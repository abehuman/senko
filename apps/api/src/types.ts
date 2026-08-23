export const API_PROTOCOLS = ["openai-completions", "openai-responses"] as const;

export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export interface CloudflareBindings {
	SENKO_API_KEYS?: string;
	SENKO_FAST_MODEL?: string;
	SENKO_MODELS?: string;
	LLM_API_BASE_URL?: string;
	LLM_API_KEY?: string;
}

export interface AppVariables {
	requestId: string;
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
	reasoning: boolean;
	supported_protocols: ApiProtocol[];
}

export interface ModelCatalog {
	byId: Map<string, ModelDefinition>;
	fast: ModelDefinition;
	models: ModelDefinition[];
}

export type LlmApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
