#!/usr/bin/env node

import { HELP_TEXT, parseCliArgs } from "./args.js";
import { SenkoError } from "./errors.js";
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
	const args = parseCliArgs(argv);
	if (args.help) {
		process.stdout.write(HELP_TEXT);
		return 0;
	}
	if (args.version) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	const stdin = await readStdin();
	const { runApp } = await import("./app.js");
	return runApp({ args, stdin, stdoutIsTty: process.stdout.isTTY });
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		if (error instanceof SenkoError) {
			process.stderr.write(`senko: ${error.message}\n`);
			if (error.exitCode === 2) process.stderr.write("Run 'senko --help' for usage.\n");
			process.exitCode = error.exitCode;
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`senko: unexpected error: ${message}\n`);
		process.exitCode = 1;
	});
