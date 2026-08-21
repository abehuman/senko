import { homedir } from "node:os";
import { dirname } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	type ResourceDiagnostic,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAutoCompactionSettings } from "./auto-compact.js";
import type { RuntimeConfig } from "./config.js";
import { createProvider } from "./provider.js";
import { createResourceLoader } from "./resources.js";

export interface SenkoRuntime {
	diagnostics: ResourceDiagnostic[];
	session: AgentSession;
}

export async function createRuntime(options: {
	config: RuntimeConfig;
	cwd: string;
	home?: string;
	sessionManager: SessionManager;
}): Promise<SenkoRuntime> {
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
	const { model, modelRuntime } = await createProvider(options.config);
	const resources = await createResourceLoader({
		agentDir: dirname(options.config.configPath),
		cwd: options.cwd,
		home: options.home ?? homedir(),
		settingsManager,
	});
	const { session, modelFallbackMessage } = await createAgentSession({
		agentDir: dirname(options.config.configPath),
		cwd: options.cwd,
		model,
		modelRuntime,
		resourceLoader: resources.loader,
		sessionManager: options.sessionManager,
		settingsManager,
		thinkingLevel: options.config.reasoning ? "medium" : "off",
		tools: ["read", "write", "edit", "bash"],
	});
	const diagnostics = [...resources.diagnostics];
	if (modelFallbackMessage) {
		diagnostics.push({ type: "warning", message: modelFallbackMessage });
	}
	return { diagnostics, session };
}
