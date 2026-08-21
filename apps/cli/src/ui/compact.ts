import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { defaultI18n, type I18n } from "../i18n/index.js";

type CompactableSession = Pick<AgentSession, "compact">;

export type CompactCommandResult =
	| { estimatedTokensAfter?: number; status: "success"; tokensBefore: number }
	| { status: "cancelled" }
	| { message: string; status: "error" };

function isCancellation(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message === "Compaction cancelled";
	}
	return error === "Compaction cancelled";
}

export async function compactCurrentSession(session: CompactableSession): Promise<CompactCommandResult> {
	try {
		const result = await session.compact();
		return {
			estimatedTokensAfter: result.estimatedTokensAfter,
			status: "success",
			tokensBefore: result.tokensBefore,
		};
	} catch (error) {
		if (isCancellation(error)) {
			return { status: "cancelled" };
		}
		return {
			message: error instanceof Error ? error.message : String(error),
			status: "error",
		};
	}
}

export function compactCommandMessage(result: CompactCommandResult, i18n: I18n = defaultI18n): string {
	switch (result.status) {
		case "success":
			return result.estimatedTokensAfter === undefined
				? i18n.t("compactedBefore", { before: result.tokensBefore })
				: i18n.t("compactedAfter", { after: result.estimatedTokensAfter, before: result.tokensBefore });
		case "cancelled":
			return i18n.t("compactionCancelled");
		case "error":
			return i18n.t("compactionFailed", { message: result.message });
	}
}
