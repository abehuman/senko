import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverResources, findRepositoryRoot, scopeDirectories } from "../src/resources.js";

const temporaryDirectories: string[] = [];

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function write(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

function skill(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("portable resource discovery", () => {
	it("combines AGENTS.md root-to-working-directory and applies nearer skills last", async () => {
		const repository = await makeDirectory("senko-resource-repo-");
		const home = await makeDirectory("senko-resource-home-");
		const cwd = join(repository, "packages", "feature");
		await mkdir(join(repository, ".git"));
		await mkdir(cwd, { recursive: true });
		await write(join(repository, "AGENTS.md"), "root instructions");
		await write(join(repository, "packages", "AGENTS.md"), "package instructions");
		await write(join(cwd, "AGENTS.md"), "feature instructions");
		await write(join(repository, ".pi", "AGENTS.md"), "must not load");
		await write(join(home, ".agents", "skills", "shared", "SKILL.md"), skill("shared", "user version"));
		await write(join(repository, ".agents", "skills", "root", "SKILL.md"), skill("root-skill", "root skill"));
		await write(join(cwd, ".agents", "skills", "shared", "SKILL.md"), skill("shared", "near project version"));

		const result = discoverResources(cwd, home);
		expect(result.repositoryRoot).toBe(repository);
		expect(result.agentsFiles.map((file) => file.content)).toEqual([
			"root instructions",
			"package instructions",
			"feature instructions",
		]);
		expect(result.agentsFiles.every((file) => !file.path.includes(".pi"))).toBe(true);
		expect(result.skills.map((entry) => entry.name).sort()).toEqual(["root-skill", "shared"]);
		expect(result.skills.find((entry) => entry.name === "shared")?.description).toBe("near project version");
	});

	it("uses only the working directory when no repository root exists", async () => {
		const cwd = await makeDirectory("senko-no-repo-");
		expect(findRepositoryRoot(cwd)).toBe(cwd);
		expect(scopeDirectories(cwd, cwd)).toEqual([cwd]);
	});
});
