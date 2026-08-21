import type { AgentSession, ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { promptWithAutoCompaction } from "./auto-compact.js";
import type { RuntimeConfig } from "./config.js";
import { SenkoError } from "./errors.js";
import { type DisplayEvent, projectEvent } from "./events.js";
import { defaultI18n, type I18n } from "./i18n/index.js";

export interface PrintIo {
	stderr: Pick<NodeJS.WriteStream, "write">;
	stdout: Pick<NodeJS.WriteStream, "write">;
}

function diagnosticType(type: ResourceDiagnostic["type"], i18n: I18n): string {
	if (type === "collision") return i18n.t("diagnosticCollision");
	if (type === "error") return i18n.t("diagnosticError");
	if (type === "warning") return i18n.t("diagnosticWarning");
	return type;
}

export function printDiagnostics(
	diagnostics: ResourceDiagnostic[],
	stderr: PrintIo["stderr"],
	i18n: I18n = defaultI18n,
): void {
	for (const diagnostic of diagnostics) {
		const location = diagnostic.path ? ` (${diagnostic.path})` : "";
		stderr.write(`senko: ${diagnosticType(diagnostic.type, i18n)}: ${diagnostic.message}${location}\n`);
	}
}

export async function runPrintMode(
	session: AgentSession,
	prompt: string,
	config: Pick<RuntimeConfig, "contextWindow" | "maxOutputTokens">,
	io: PrintIo = { stderr: process.stderr, stdout: process.stdout },
	i18n: I18n = defaultI18n,
): Promise<number> {
	let wroteText = false;
	let errorMessage: string | undefined;
	let interrupted = false;
	const display = (projected: DisplayEvent) => {
		switch (projected.type) {
			case "auto_compaction_start":
				io.stderr.write(`\nsenko: ${projected.text}\n`);
				break;
			case "auto_compaction_end":
				io.stderr.write(`senko: ${projected.text}\n`);
				if (projected.status === "success" && projected.willRetry) {
					errorMessage = undefined;
				}
				break;
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
				io.stderr.write(
					`${projected.isError ? "✗" : "✓"} ${projected.isError ? i18n.t("toolFailed") : i18n.t("toolFinished")}`,
				);
				if (projected.text) io.stderr.write(`: ${projected.text}`);
				io.stderr.write("\n");
				break;
			case "error":
				errorMessage = projected.text;
				break;
		}
	};
	const unsubscribe = session.subscribe((event) => {
		for (const projected of projectEvent(event, i18n)) {
			display(projected);
		}
	});
	const onSigint = () => {
		interrupted = true;
		if (session.isCompacting) {
			session.abortCompaction();
		} else {
			void session.abort();
		}
	};
	process.once("SIGINT", onSigint);
	let promptResult: Awaited<ReturnType<typeof promptWithAutoCompaction>> | undefined;
	try {
		promptResult = await promptWithAutoCompaction({
			config,
			i18n,
			isCancelled: () => interrupted,
			onDisplayEvent: display,
			prompt,
			session,
		});
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
	if (promptResult?.status === "cancelled") {
		return 130;
	}
	if (promptResult?.status === "compaction-error") {
		return 1;
	}
	if (errorMessage) {
		throw new SenkoError(errorMessage);
	}
	return 0;
}
