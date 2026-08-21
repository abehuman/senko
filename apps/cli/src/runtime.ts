import { homedir } from "node:os";
import { dirname } from "node:path";
import {
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	type ResourceDiagnostic,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAutoCompactionSettings } from "./auto-compact.js";
import type { RuntimeConfig } from "./config.js";
import { defaultI18n, type I18n } from "./i18n/index.js";
import { createProvider } from "./provider.js";
import { createResourceLoader } from "./resources.js";

export interface SenkoRuntime {
	diagnostics: ResourceDiagnostic[];
	sessionRuntime: AgentSessionRuntime;
}

function runtimeDiagnostics(diagnostics: ResourceDiagnostic[]): AgentSessionRuntimeDiagnostic[] {
	return diagnostics.map((diagnostic) => ({
		message: diagnostic.message,
		type: diagnostic.type === "collision" ? "warning" : diagnostic.type,
	}));
}

export async function createRuntime(options: {
	config: RuntimeConfig;
	cwd: string;
	home?: string;
	i18n?: I18n;
	sessionManager: SessionManager;
}): Promise<SenkoRuntime> {
	const agentDir = dirname(options.config.configPath);
	const home = options.home ?? homedir();
	const i18n = options.i18n ?? defaultI18n;
	let startupDiagnostics: ResourceDiagnostic[] = [];
	const createSessionRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const settingsManager = SettingsManager.inMemory({
			compaction: createAutoCompactionSettings(options.config),
			defaultProjectTrust: "always",
			defaultTools: ["read", "write", "edit", "bash"],
			enableAnalytics: false,
			enableInstallTelemetry: false,
			httpIdleTimeoutMs: 0,
			images: { blockImages: true },
			retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		});
		const { model, modelRuntime } = await createProvider(options.config, i18n);
		const resources = await createResourceLoader({ agentDir, cwd, home, settingsManager });
		const diagnostics = [...resources.diagnostics];
		const services: AgentSessionServices = {
			agentDir,
			cwd,
			diagnostics: runtimeDiagnostics(diagnostics),
			modelRuntime,
			resourceLoader: resources.loader,
			settingsManager,
		};
		const session = await createAgentSessionFromServices({
			model,
			sessionManager,
			sessionStartEvent,
			services,
			thinkingLevel: options.config.reasoning ? "medium" : "off",
			tools: ["read", "write", "edit", "bash"],
		});
		if (session.modelFallbackMessage) {
			diagnostics.push({ type: "warning", message: session.modelFallbackMessage });
		}
		startupDiagnostics = diagnostics;
		return { ...session, diagnostics: runtimeDiagnostics(diagnostics), services };
	};
	const sessionRuntime = await createAgentSessionRuntime(createSessionRuntime, {
		agentDir,
		cwd: options.cwd,
		sessionManager: options.sessionManager,
	});
	return { diagnostics: startupDiagnostics, sessionRuntime };
}
