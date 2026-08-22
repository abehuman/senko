import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createI18n,
	detectSystemLocale,
	normalizeLocale,
	resolveCliLocale,
	SUPPORTED_LOCALES,
} from "../src/i18n/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function configPath(language: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "senko-i18n-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ language }), "utf8");
	return path;
}

describe("locale resolution", () => {
	it.each([
		["en_US.UTF-8", "en"],
		["ja_JP.UTF-8", "ja"],
		["C", "en"],
	])("normalizes %s to %s", (input, expected) => {
		expect(normalizeLocale(input)).toBe(expected);
	});

	it("rejects unsupported locale values", () => {
		expect(normalizeLocale("fr-FR")).toBeUndefined();
		expect(normalizeLocale("zh-CN")).toBeUndefined();
		expect(normalizeLocale("zh-TW")).toBeUndefined();
	});

	it("respects system locale environment precedence", () => {
		expect(
			detectSystemLocale({
				env: {
					LANG: "en_US.UTF-8",
					LANGUAGE: "fr:en",
					LC_ALL: "ja_JP.UTF-8",
					LC_MESSAGES: "en_US.UTF-8",
				},
				runtimeLocale: "en-US",
			}),
		).toBe("ja");
	});

	it("uses the first supported LANGUAGE preference before LANG", () => {
		expect(
			detectSystemLocale({
				env: { LANG: "en_US.UTF-8", LANGUAGE: "fr:ja" },
				runtimeLocale: "en-US",
			}),
		).toBe("ja");
	});

	it("uses the runtime locale after unsupported environment locales", () => {
		expect(detectSystemLocale({ env: { LANG: "fr_FR.UTF-8" }, runtimeLocale: "ja-JP" })).toBe("ja");
		expect(detectSystemLocale({ env: {}, runtimeLocale: "fr-FR" })).toBeUndefined();
	});

	it("uses command line, environment, config, then terminal locale precedence", async () => {
		const path = await configPath("ja");
		expect(
			await resolveCliLocale({
				argv: ["--language", "en"],
				configPath: path,
				env: { LANG: "en_US.UTF-8", SENKO_LANGUAGE: "ja" },
			}),
		).toBe("en");
		expect(await resolveCliLocale({ argv: [], configPath: path, env: { LANG: "en_US.UTF-8" } })).toBe("ja");
		expect(
			await resolveCliLocale({
				argv: [],
				configPath: join(tmpdir(), "missing-senko-config"),
				env: { LANG: "ja_JP.UTF-8" },
			}),
		).toBe("ja");
	});

	it("falls back to English when no supported locale is available", async () => {
		expect(
			await resolveCliLocale({
				argv: [],
				configPath: join(tmpdir(), "missing-senko-config"),
				env: { LANG: "zh_CN.UTF-8" },
				runtimeLocale: "zh-TW",
			}),
		).toBe("en");
	});
});

describe("translations", () => {
	it("provides native help and command copy for every supported locale", () => {
		const taglines = SUPPORTED_LOCALES.map((locale) => createI18n(locale).t("headerTagline"));
		expect(taglines).toEqual(["fast coding agent", "高速コーディングエージェント"]);
		for (const locale of SUPPORTED_LOCALES) {
			const i18n = createI18n(locale);
			expect(i18n.t("helpText")).toContain("--language <locale>");
			expect(i18n.t("commandCompactDescription").length).toBeGreaterThan(0);
		}
	});

	it("formats dynamic values with the selected locale", () => {
		const japanese = createI18n("ja");
		expect(japanese.t("compactedAfter", { after: 6_789, before: 12_345 })).toBe(
			"コンテキストを圧縮しました: 12,345 → 約6,789トークン。",
		);
		expect(japanese.dateTime(new Date("2026-08-21T04:05:06.000Z"))).toContain("2026");
	});

	it("keeps session identifiers out of busy footers", () => {
		expect(createI18n("en").t("footerWorking", { model: "fast" })).toBe("working · Esc/Ctrl+C abort · fast");
		expect(createI18n("ja").t("footerCompacting", { model: "fast" })).toBe("圧縮中 · Esc/Ctrl+Cで中止 · fast");
	});
});
