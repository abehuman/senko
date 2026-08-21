import { type AgentSession, type CompactionResult, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "./config.js";

const MAX_RECENT_TOKENS = 20_000;
const SUMMARY_OUTPUT_RATIO = 0.8;

/**
 * Pi 0.84.2 always keeps this additional amount free when it calculates the
 * output limit for a provider request. Keep Senko's compaction threshold in
 * sync so a request is not silently reduced to a one-token response first.
 */
export const PI_CONTEXT_SAFETY_TOKENS = 4_096;

export interface AutoCompactionSettings {
	enabled: true;
	keepRecentTokens: number;
	reserveTokens: number;
}

export type AutoCompactionDisplayEvent =
	| { type: "auto_compaction_start"; reason: "overflow" | "threshold"; text: string }
	| {
			type: "auto_compaction_end";
			status: "cancelled" | "error" | "success";
			text: string;
			willRetry: boolean;
	  };

export type PromptWithAutoCompactionResult =
	| { status: "cancelled" }
	| { message: string; status: "compaction-error" }
	| { status: "prompted" };

type PromptableSession = Pick<AgentSession, "compact" | "getContextUsage" | "prompt">;

interface CompactionEndDetails {
	aborted: boolean;
	errorMessage?: string;
	result?: Pick<CompactionResult, "estimatedTokensAfter" | "tokensBefore">;
	willRetry: boolean;
}

/**
 * Keep room for a maximum-size response plus Pi's fixed transport margin. The
 * retained tail also leaves room for the generated summary after compaction.
 */
export function createAutoCompactionSettings(
	config: Pick<RuntimeConfig, "contextWindow" | "maxOutputTokens">,
): AutoCompactionSettings {
	const reserveTokens = config.maxOutputTokens + PI_CONTEXT_SAFETY_TOKENS;
	const summaryBudget = Math.min(config.maxOutputTokens, Math.floor(reserveTokens * SUMMARY_OUTPUT_RATIO));
	return {
		enabled: true,
		keepRecentTokens: Math.max(1, Math.min(MAX_RECENT_TOKENS, config.contextWindow - reserveTokens - summaryBudget)),
		reserveTokens,
	};
}

function tokenCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function autoCompactionStartEvent(
	reason: "overflow" | "threshold",
): Extract<AutoCompactionDisplayEvent, { type: "auto_compaction_start" }> {
	return {
		reason,
		text:
			reason === "overflow"
				? "Context limit reached; auto-compacting before retry…"
				: "Auto-compacting context before the limit…",
		type: "auto_compaction_start",
	};
}

export function autoCompactionEndEvent(
	details: CompactionEndDetails,
): Extract<AutoCompactionDisplayEvent, { type: "auto_compaction_end" }> {
	if (details.aborted) {
		return {
			status: "cancelled",
			text: "Auto-compaction cancelled.",
			type: "auto_compaction_end",
			willRetry: false,
		};
	}
	if (!details.result) {
		return {
			status: "error",
			text: details.errorMessage ?? "Auto-compaction failed.",
			type: "auto_compaction_end",
			willRetry: false,
		};
	}

	const compacted =
		details.result.estimatedTokensAfter === undefined
			? `Context auto-compacted (${tokenCount(details.result.tokensBefore)} tokens before).`
			: `Context auto-compacted: ${tokenCount(details.result.tokensBefore)} → ~${tokenCount(details.result.estimatedTokensAfter)} tokens.`;
	return {
		status: "success",
		text: details.willRetry ? `${compacted} Retrying the request.` : compacted,
		type: "auto_compaction_end",
		willRetry: details.willRetry,
	};
}

function estimatePromptTokens(prompt: string): number {
	const message = {
		content: [{ text: prompt, type: "text" }],
		role: "user",
		timestamp: Date.now(),
	} as Parameters<typeof estimateTokens>[0];
	return estimateTokens(message);
}

function pendingPromptBudget(
	session: Pick<AgentSession, "getContextUsage">,
	prompt: string,
	config: Pick<RuntimeConfig, "contextWindow" | "maxOutputTokens">,
): { promptTokens: number; safeThreshold: number; totalTokens: number } | undefined {
	const usage = session.getContextUsage();
	if (!usage || usage.tokens === null) {
		return undefined;
	}
	const settings = createAutoCompactionSettings(config);
	const promptTokens = estimatePromptTokens(prompt);
	return {
		promptTokens,
		safeThreshold: usage.contextWindow - settings.reserveTokens,
		totalTokens: usage.tokens + promptTokens,
	};
}

export function shouldCompactBeforePrompt(
	session: Pick<AgentSession, "getContextUsage">,
	prompt: string,
	config: Pick<RuntimeConfig, "contextWindow" | "maxOutputTokens">,
): boolean {
	const budget = pendingPromptBudget(session, prompt, config);
	return budget !== undefined && budget.totalTokens > budget.safeThreshold;
}

function isCancellation(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message === "Compaction cancelled";
	}
	return error === "Compaction cancelled";
}

/**
 * Compact before adding a prompt that would cross Senko's safe threshold. Pi's
 * own automatic compaction remains enabled as a fallback for provider-reported
 * overflows and usage growth that occurs while the agent is working.
 */
export async function promptWithAutoCompaction(options: {
	config: Pick<RuntimeConfig, "contextWindow" | "maxOutputTokens">;
	isCancelled?: () => boolean;
	onDisplayEvent?: (event: AutoCompactionDisplayEvent) => void;
	prompt: string;
	session: PromptableSession;
}): Promise<PromptWithAutoCompactionResult> {
	const budget = pendingPromptBudget(options.session, options.prompt, options.config);
	if (budget && budget.totalTokens > budget.safeThreshold) {
		options.onDisplayEvent?.(autoCompactionStartEvent("threshold"));
		try {
			const result = await options.session.compact();
			if (
				result.estimatedTokensAfter !== undefined &&
				result.estimatedTokensAfter + budget.promptTokens > budget.safeThreshold
			) {
				const message =
					"Context was compacted, but the pending prompt still exceeds the safe context budget. Shorten the prompt or configure a larger contextWindow.";
				options.onDisplayEvent?.(autoCompactionEndEvent({ aborted: false, errorMessage: message, willRetry: false }));
				return { message, status: "compaction-error" };
			}
			options.onDisplayEvent?.(autoCompactionEndEvent({ aborted: false, result, willRetry: false }));
		} catch (error) {
			if (isCancellation(error)) {
				options.onDisplayEvent?.(autoCompactionEndEvent({ aborted: true, willRetry: false }));
				return { status: "cancelled" };
			}
			const message = error instanceof Error ? error.message : String(error);
			const displayMessage = `Auto-compaction failed: ${message}`;
			options.onDisplayEvent?.(
				autoCompactionEndEvent({
					aborted: false,
					errorMessage: displayMessage,
					willRetry: false,
				}),
			);
			return { message: displayMessage, status: "compaction-error" };
		}
	}

	if (options.isCancelled?.()) {
		return { status: "cancelled" };
	}
	await options.session.prompt(options.prompt, { source: "interactive" });
	return { status: "prompted" };
}
