import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "./config.js";
import { SenkoError } from "./errors.js";
import { defaultI18n, type I18n } from "./i18n/index.js";

const LOCAL_DEVELOPMENT_KEY = "senko-loopback-no-user-key";

export async function createProvider(
	config: RuntimeConfig,
	i18n: I18n = defaultI18n,
): Promise<{
	model: Model<Api>;
	modelRuntime: ModelRuntime;
}> {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("senko", {
		api: config.api,
		baseUrl: config.baseUrl,
		models: [
			{
				api: config.api,
				baseUrl: config.baseUrl,
				contextWindow: config.contextWindow,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
				id: config.model,
				input: ["text"],
				maxTokens: config.maxOutputTokens,
				name: config.model,
				reasoning: config.reasoning,
			},
		],
		name: "Senko",
	});
	await modelRuntime.setRuntimeApiKey("senko", config.apiKey ?? LOCAL_DEVELOPMENT_KEY);
	const model = modelRuntime.getModel("senko", config.model);
	if (!model) {
		throw new SenkoError(i18n.t("modelRegistrationFailed", { model: config.model }));
	}
	return { model, modelRuntime };
}
