import type { AgentSession } from "@earendil-works/pi-coding-agent";

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

function tokenCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function compactCommandMessage(result: CompactCommandResult): string {
	switch (result.status) {
		case "success":
			return result.estimatedTokensAfter === undefined
				? `Context compacted (${tokenCount(result.tokensBefore)} tokens before).`
				: `Context compacted: ${tokenCount(result.tokensBefore)} → ~${tokenCount(result.estimatedTokensAfter)} tokens.`;
		case "cancelled":
			return "Compaction cancelled.";
		case "error":
			return `Compaction failed: ${result.message}`;
	}
}
