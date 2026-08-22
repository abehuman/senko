export const SUPPORTED_LOCALES = ["en", "ja"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export interface Formatters {
	dateTime(value: Date): string;
	number(value: number): string;
}
