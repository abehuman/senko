import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	DefaultResourceLoader,
	loadSkillsFromDir,
	type ResourceDiagnostic,
	type SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";

export interface DiscoveredResources {
	agentsFiles: Array<{ path: string; content: string }>;
	diagnostics: ResourceDiagnostic[];
	repositoryRoot: string;
	skills: Skill[];
}

const baseSystemPromptUrl = new URL("./prompts/base.md", import.meta.url);

export function loadBaseSystemPrompt(): string {
	return readFileSync(baseSystemPromptUrl, "utf8").trim();
}

export function findRepositoryRoot(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	let current = resolvedCwd;
	while (true) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolvedCwd;
		}
		current = parent;
	}
}

export function scopeDirectories(repositoryRoot: string, cwd: string): string[] {
	const root = resolve(repositoryRoot);
	const target = resolve(cwd);
	const relativePath = relative(root, target);
	if (relativePath.startsWith("..") || resolve(root, relativePath) !== target) {
		return [target];
	}
	const directories = [root];
	if (!relativePath) {
		return directories;
	}
	let current = root;
	for (const segment of relativePath.split(/[\\/]/)) {
		current = join(current, segment);
		directories.push(current);
	}
	return directories;
}

export function discoverResources(cwd: string, home: string): DiscoveredResources {
	const repositoryRoot = findRepositoryRoot(cwd);
	const scopes = scopeDirectories(repositoryRoot, cwd);
	const agentsFiles: Array<{ path: string; content: string }> = [];
	for (const scope of scopes) {
		const path = join(scope, "AGENTS.md");
		if (existsSync(path)) {
			agentsFiles.push({ path, content: readFileSync(path, "utf8") });
		}
	}

	const skillMap = new Map<string, Skill>();
	const diagnostics: ResourceDiagnostic[] = [];
	const addSkills = (directory: string, source: "user" | "project") => {
		const result = loadSkillsFromDir({ dir: directory, source });
		diagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			skillMap.set(skill.name, skill);
		}
	};
	addSkills(join(home, ".agents", "skills"), "user");
	for (const scope of scopes) {
		addSkills(join(scope, ".agents", "skills"), "project");
	}

	return {
		agentsFiles,
		diagnostics,
		repositoryRoot,
		skills: [...skillMap.values()],
	};
}

export async function createResourceLoader(options: {
	agentDir: string;
	cwd: string;
	home: string;
	settingsManager: SettingsManager;
}): Promise<{ diagnostics: ResourceDiagnostic[]; loader: DefaultResourceLoader }> {
	const resources = discoverResources(options.cwd, options.home);
	const loader = new DefaultResourceLoader({
		agentDir: options.agentDir,
		agentsFilesOverride: () => ({ agentsFiles: resources.agentsFiles }),
		appendSystemPrompt: [],
		cwd: options.cwd,
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		settingsManager: options.settingsManager,
		skillsOverride: () => ({ diagnostics: resources.diagnostics, skills: resources.skills }),
		systemPrompt: loadBaseSystemPrompt(),
	});
	await loader.reload();
	return { diagnostics: resources.diagnostics, loader };
}
