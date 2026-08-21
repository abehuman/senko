import { readFile } from "node:fs/promises";
import { getConfigPath } from "../paths.js";
import { createEnglishMessages, type Messages } from "./locales/en.js";
import { createJapaneseMessages } from "./locales/ja.js";
import { createSimplifiedChineseMessages } from "./locales/zh-cn.js";
import { createTraditionalChineseMessages } from "./locales/zh-tw.js";
import { type Formatters, type Locale, SUPPORTED_LOCALES } from "./types.js";

export { type Locale, SUPPORTED_LOCALES } from "./types.js";

export type MessageKey = keyof Messages;

export interface I18n extends Formatters {
	locale: Locale;
	t<K extends MessageKey>(key: K, ...args: Parameters<Messages[K]>): string;
}

const supportedLocaleSet = new Set<string>(SUPPORTED_LOCALES);

export function normalizeLocale(value: string | undefined): Locale | undefined {
	if (!value) return undefined;
	const normalized = value
		.trim()
		.replace(/_/g, "-")
		.replace(/[.@].*$/, "")
		.toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "c" || normalized === "posix") return "en";
	if (normalized === "en" || normalized.startsWith("en-")) return "en";
	if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
	if (normalized === "zh" || normalized.startsWith("zh-")) {
		if (/^zh-(tw|hk|mo|hant)(-|$)/.test(normalized)) return "zh-TW";
		return "zh-CN";
	}
	return undefined;
}

export function isCanonicalLocale(value: string): value is Locale {
	return supportedLocaleSet.has(value);
}

function createFormatters(locale: Locale): Formatters {
	const dateTime = new Intl.DateTimeFormat(locale, {
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		minute: "2-digit",
		month: "2-digit",
		second: "2-digit",
		timeZone: "UTC",
		timeZoneName: "short",
		year: "numeric",
	});
	const number = new Intl.NumberFormat(locale);
	return {
		dateTime: (value) => dateTime.format(value),
		number: (value) => number.format(value),
	};
}

export function createI18n(locale: Locale): I18n {
	const formatters = createFormatters(locale);
	const messages: Messages =
		locale === "ja"
			? createJapaneseMessages(formatters)
			: locale === "zh-CN"
				? createSimplifiedChineseMessages(formatters)
				: locale === "zh-TW"
					? createTraditionalChineseMessages(formatters)
					: createEnglishMessages(formatters);
	return {
		...formatters,
		locale,
		t<K extends MessageKey>(key: K, ...args: Parameters<Messages[K]>): string {
			const message = messages[key] as (...parameters: Parameters<Messages[K]>) => string;
			return message(...args);
		},
	};
}

export const defaultI18n = createI18n("en");

function languageFromArgv(argv: string[]): string | undefined {
	let language: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--language") {
			language = argv[index + 1];
			index += 1;
		} else if (argument?.startsWith("--language=")) {
			language = argument.slice("--language=".length);
		}
	}
	return language;
}

async function languageFromConfig(path: string): Promise<string | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const language = (parsed as Record<string, unknown>).language;
		return typeof language === "string" ? language : undefined;
	} catch {
		return undefined;
	}
}

export async function resolveCliLocale(options: {
	argv: string[];
	configPath?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<Locale> {
	const env = options.env ?? process.env;
	for (const candidate of [languageFromArgv(options.argv), env.SENKO_LANGUAGE]) {
		const locale = normalizeLocale(candidate);
		if (locale) return locale;
	}
	const configuredLocale = normalizeLocale(await languageFromConfig(options.configPath ?? getConfigPath(env)));
	if (configuredLocale) return configuredLocale;
	for (const candidate of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
		const locale = normalizeLocale(candidate);
		if (locale) return locale;
	}
	return "en";
}
