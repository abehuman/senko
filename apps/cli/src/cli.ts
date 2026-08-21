#!/usr/bin/env node

import { helpText, parseCliArgs } from "./args.js";
import { SenkoError } from "./errors.js";
import { createI18n, resolveCliLocale } from "./i18n/index.js";
import { VERSION } from "./version.js";

async function readStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) {
		return undefined;
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const i18n = createI18n(await resolveCliLocale({ argv }));
	const args = parseCliArgs(argv, i18n);
	if (args.help) {
		process.stdout.write(helpText(i18n));
		return 0;
	}
	if (args.version) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	const stdin = await readStdin();
	const { runApp } = await import("./app.js");
	return runApp({ args, i18n, stdin, stdoutIsTty: process.stdout.isTTY });
}

async function reportError(error: unknown): Promise<void> {
	const i18n = createI18n(await resolveCliLocale({ argv: process.argv.slice(2) }));
	if (error instanceof SenkoError) {
		process.stderr.write(`senko: ${error.message}\n`);
		if (error.exitCode === 2) process.stderr.write(`${i18n.t("cliUsageHint")}\n`);
		process.exitCode = error.exitCode;
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${i18n.t("cliUnexpectedError", { message })}\n`);
	process.exitCode = 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch(reportError);
