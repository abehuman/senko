import { readFile } from "node:fs/promises";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import { describe, expect, it } from "vitest";

interface InventoryBinding {
	kind: "durable_object" | "secret" | "text";
	managedBy: "cloudflare-dashboard" | "cloudflare-secret" | "wrangler";
	name: string;
	operatorAction: string;
	requiredFor: string[];
}

interface Inventory {
	bindings: InventoryBinding[];
	schemaVersion: number;
}

function path(relative: string): string {
	return fileURLToPath(new NodeUrl(relative, import.meta.url));
}

async function inventory(): Promise<Inventory> {
	return JSON.parse(await readFile(path("../config-inventory.json"), "utf8")) as Inventory;
}

describe("Worker configuration inventory", () => {
	it("covers every typed Worker binding exactly once", async () => {
		const configuration = await inventory();
		const types = await readFile(path("../src/types.ts"), "utf8");
		const typedBindings = [...types.matchAll(/^\s*([A-Z][A-Z0-9_]+)\?:/gm)].map((match) => match[1]);
		const inventoryBindings = configuration.bindings.map((binding) => binding.name);
		expect(configuration.schemaVersion).toBe(1);
		expect(new Set(inventoryBindings).size).toBe(inventoryBindings.length);
		expect(inventoryBindings.sort()).toEqual(typedBindings.sort());
	});

	it("classifies secrets and infrastructure without storing values", async () => {
		const raw = await readFile(path("../config-inventory.json"), "utf8");
		const configuration = JSON.parse(raw) as Inventory;
		expect(raw).not.toMatch(/"(default|example|value)"\s*:/);
		for (const binding of configuration.bindings) {
			expect(binding.name).toMatch(/^[A-Z][A-Z0-9_]+$/);
			expect(binding.operatorAction.length).toBeGreaterThan(20);
			expect(binding.requiredFor.length).toBeGreaterThan(0);
			if (binding.kind === "secret") expect(binding.managedBy).toBe("cloudflare-secret");
			if (binding.kind === "text") expect(binding.managedBy).toBe("cloudflare-dashboard");
			if (binding.kind === "durable_object") expect(binding.managedBy).toBe("wrangler");
		}
	});

	it("keeps Wrangler Durable Object bindings and the operator README aligned", async () => {
		const configuration = await inventory();
		const wrangler = JSON.parse(await readFile(path("../wrangler.jsonc"), "utf8")) as {
			durable_objects: { bindings: Array<{ name: string }> };
		};
		const readme = await readFile(path("../README.md"), "utf8");
		const durableObjects = configuration.bindings
			.filter((binding) => binding.kind === "durable_object")
			.map((binding) => binding.name)
			.sort();
		expect(wrangler.durable_objects.bindings.map((binding) => binding.name).sort()).toEqual(durableObjects);
		for (const binding of configuration.bindings) expect(readme).toContain(`\`${binding.name}\``);
	});

	it("keeps database mode free of bootstrap-only credentials", async () => {
		const configuration = await inventory();
		const bootstrapOnly = configuration.bindings
			.filter((binding) => binding.requiredFor.length === 1 && binding.requiredFor[0] === "bootstrap")
			.map((binding) => binding.name)
			.sort();
		expect(bootstrapOnly).toEqual(["LLM_API_BASE_URL", "LLM_API_KEY", "SENKO_API_KEYS"]);
	});
});
