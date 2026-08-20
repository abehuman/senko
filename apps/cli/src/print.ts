import type { AgentSession, ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { SenkoError } from "./errors.js";
import { projectEvent } from "./events.js";

export interface PrintIo {
	stderr: Pick<NodeJS.WriteStream, "write">;
	stdout: Pick<NodeJS.WriteStream, "write">;
}

export function printDiagnostics(diagnostics: ResourceDiagnostic[], stderr: PrintIo["stderr"]): void {
	for (const diagnostic of diagnostics) {
		const location = diagnostic.path ? ` (${diagnostic.path})` : "";
		stderr.write(`senko: ${diagnostic.type}: ${diagnostic.message}${location}\n`);
	}
}

export async function runPrintMode(
	session: AgentSession,
	prompt: string,
	io: PrintIo = { stderr: process.stderr, stdout: process.stdout },
): Promise<number> {
	let wroteText = false;
	let errorMessage: string | undefined;
	let interrupted = false;
	const unsubscribe = session.subscribe((event) => {
		for (const projected of projectEvent(event)) {
			switch (projected.type) {
				case "text_delta":
					wroteText = true;
					io.stdout.write(projected.text);
					break;
				case "thinking_delta":
					io.stderr.write(projected.text);
					break;
				case "tool_start":
					io.stderr.write(`\n→ ${projected.label}\n`);
					break;
				case "tool_update":
					if (projected.text) io.stderr.write(`${projected.text}\n`);
					break;
				case "tool_end":
					io.stderr.write(`${projected.isError ? "✗" : "✓"} tool ${projected.isError ? "failed" : "finished"}`);
					if (projected.text) io.stderr.write(`: ${projected.text}`);
					io.stderr.write("\n");
					break;
				case "error":
					errorMessage = projected.text;
					break;
			}
		}
	});
	const onSigint = () => {
		interrupted = true;
		void session.abort();
	};
	process.once("SIGINT", onSigint);
	try {
		await session.prompt(prompt, { source: "interactive" });
	} finally {
		process.removeListener("SIGINT", onSigint);
		unsubscribe();
		if (wroteText) {
			io.stdout.write("\n");
		}
	}
	if (interrupted) {
		return 130;
	}
	if (errorMessage) {
		throw new SenkoError(errorMessage);
	}
	return 0;
}
