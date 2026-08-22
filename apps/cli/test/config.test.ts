import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeBaseUrl, parseConfigFile, resolveConfig } from "../src/config.js";
import { createI18n } from "../src/i18n/index.js";
import { getConfigPath, getSessionsDir } from "../src/paths.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "senko-config-test-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("resolveConfig", () => {
	it("uses flags before environment, file values, and defaults", async () => {
		const directory = await temporaryDirectory();
		const configPath = join(directory, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				api: "openai-completions",
				baseUrl: "https://file.example/v1",
				contextWindow: 65_536,
				language: "ja",
				maxOutputTokens: 8_192,
				model: "file-model",
				reasoning: true,
			}),
		);

		const config = await resolveConfig({
			args: {
				api: "openai-responses",
				baseUrl: "https://flag.example/v1/",
				language: "ja",
				model: "flag-model",
			},
			configPath,
			env: {
				SENKO_API: "openai-completions",
				SENKO_API_KEY: "test-secret",
				SENKO_BASE_URL: "https://env.example/v1",
				SENKO_LANGUAGE: "en",
			},
		});

		expect(config).toMatchObject({
			api: "openai-responses",
			apiKey: "test-secret",
			baseUrl: "https://flag.example/v1",
			contextWindow: 65_536,
			language: "ja",
			maxOutputTokens: 8_192,
			model: "flag-model",
			reasoning: true,
		});
	});

	it("ignores the removed model environment override", async () => {
		const removedModelEnvironmentVariable = ["SENKO", "MODEL"].join("_");
		const config = await resolveConfig({
			args: {},
			configPath: join(await temporaryDirectory(), "missing.json"),
			env: {
				SENKO_BASE_URL: "http://127.0.0.1:9000/v1",
				[removedModelEnvironmentVariable]: "legacy-model",
			},
		});

		expect(config.model).toBe("fast");
	});

	it("uses the Senko API root by default", async () => {
		const config = await resolveConfig({
			args: {},
			configPath: join(await temporaryDirectory(), "missing.json"),
			env: { SENKO_API_KEY: "test-secret" },
		});

		expect(config).toMatchObject({
			apiKey: "test-secret",
			baseUrl: "https://api.senkocode.com/v1",
			isLoopback: false,
		});
	});

	it("validates configured languages with localized errors", async () => {
		const directory = await temporaryDirectory();
		const configPath = join(directory, "config.json");
		await writeFile(configPath, JSON.stringify({ baseUrl: "http://localhost:9000/v1", language: "fr" }));

		await expect(resolveConfig({ args: {}, configPath, env: {}, i18n: createI18n("ja") })).rejects.toThrow(
			"未対応の言語",
		);
	});

	it("allows unauthenticated loopback and applies conservative defaults", async () => {
		const config = await resolveConfig({
			args: {},
			configPath: join(await temporaryDirectory(), "missing.json"),
			env: { SENKO_BASE_URL: "http://127.0.0.1:9000/v1/" },
		});

		expect(config).toMatchObject({
			api: "openai-completions",
			apiKey: undefined,
			baseUrl: "http://127.0.0.1:9000/v1",
			contextWindow: 32_768,
			isLoopback: true,
			maxOutputTokens: 4_096,
			model: "fast",
			reasoning: false,
		});
	});

	it("recognizes IPv4, IPv6, and localhost loopback endpoints", () => {
		expect(normalizeBaseUrl("http://127.0.0.2:9000/v1").isLoopback).toBe(true);
		expect(normalizeBaseUrl("http://[::1]:9000/v1").isLoopback).toBe(true);
		expect(normalizeBaseUrl("http://dev.localhost:9000/v1").isLoopback).toBe(true);
	});

	it("requires an environment key for the default remote endpoint", async () => {
		await expect(
			resolveConfig({
				args: {},
				configPath: join(await temporaryDirectory(), "missing.json"),
				env: {},
			}),
		).rejects.toThrow("SENKO_API_KEY is required");
	});

	it("does not invent an API root path", () => {
		expect(normalizeBaseUrl("https://api.example/custom/").baseUrl).toBe("https://api.example/custom");
		expect(normalizeBaseUrl("https://api.example").baseUrl).toBe("https://api.example");
	});

	it("requires room for model input in the configured context window", async () => {
		const directory = await temporaryDirectory();
		const configPath = join(directory, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				baseUrl: "http://localhost:9000/v1",
				contextWindow: 4_096,
				maxOutputTokens: 4_096,
			}),
		);

		await expect(resolveConfig({ args: {}, configPath, env: {} })).rejects.toThrow(
			"contextWindow must be greater than maxOutputTokens plus 4,096 safety tokens",
		);
	});

	it("rejects a one-token output limit", async () => {
		const directory = await temporaryDirectory();
		const configPath = join(directory, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				baseUrl: "http://localhost:9000/v1",
				contextWindow: 32_768,
				maxOutputTokens: 1,
			}),
		);

		await expect(resolveConfig({ args: {}, configPath, env: {} })).rejects.toThrow(
			"maxOutputTokens must be at least 2",
		);
	});

	it.each([
		["not-a-url", "absolute HTTP or HTTPS"],
		["ftp://localhost/v1", "must use HTTP or HTTPS"],
		["https://user:pass@example.com/v1", "cannot contain credentials"],
		["https://example.com/v1?q=1", "cannot contain credentials"],
	])("rejects an invalid base URL %s", (url, message) => {
		expect(() => normalizeBaseUrl(url)).toThrow(message);
	});
});

describe("configuration secrets and paths", () => {
	it("rejects API keys and unknown fields in config files", () => {
		expect(() => parseConfigFile('{"apiKey":"secret"}', "/config.json")).toThrow("API keys are not allowed");
		expect(() => parseConfigFile('{"unknown":true}', "/config.json")).toThrow("Unknown configuration field");
	});

	it("uses absolute XDG homes and falls back for relative values", () => {
		expect(getConfigPath({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/tester")).toBe("/xdg/config/senko/config.json");
		expect(getSessionsDir({ XDG_STATE_HOME: "/xdg/state" }, "/home/tester")).toBe("/xdg/state/senko/sessions");
		expect(getConfigPath({ XDG_CONFIG_HOME: "relative" }, "/home/tester")).toBe(
			"/home/tester/.config/senko/config.json",
		);
	});
});
