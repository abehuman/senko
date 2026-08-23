export const LLM_FIRST_BYTE_TIMEOUT_MS = 60_000;
export const LLM_STREAM_IDLE_TIMEOUT_MS = 45_000;
export const LLM_TOTAL_TIMEOUT_MS = 5 * 60_000;
export const MAX_LLM_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 256 * 1024;
export const MAX_LLM_ERROR_BYTES = 64 * 1024;

export type ProviderAbortReason =
	| "admission_lost"
	| "client_aborted"
	| "first_byte_timeout"
	| "response_too_large"
	| "stream_event_too_large"
	| "stream_idle_timeout"
	| "total_timeout";

export interface ProviderRequestLimits {
	firstByteTimeoutMs: number;
	maxResponseBytes: number;
	maxSseEventBytes: number;
	streamIdleTimeoutMs: number;
	totalTimeoutMs: number;
}

export const DEFAULT_PROVIDER_REQUEST_LIMITS: ProviderRequestLimits = {
	firstByteTimeoutMs: LLM_FIRST_BYTE_TIMEOUT_MS,
	maxResponseBytes: MAX_LLM_RESPONSE_BYTES,
	maxSseEventBytes: MAX_SSE_EVENT_BYTES,
	streamIdleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS,
	totalTimeoutMs: LLM_TOTAL_TIMEOUT_MS,
};

export interface ProviderRequestControl {
	abort(reason: ProviderAbortReason): void;
	finish(): void;
	markResponseStarted(): void;
	readonly reason: ProviderAbortReason | undefined;
	readonly signal: AbortSignal;
	touch(): void;
}

function timeoutDelay(deadlineAt: number, maximumDelay: number): number {
	return Math.max(1, Math.min(maximumDelay, deadlineAt - Date.now()));
}

export function createProviderRequestControl(
	clientSignal: AbortSignal,
	deadlineAt: number,
	limits: ProviderRequestLimits,
): ProviderRequestControl {
	const controller = new AbortController();
	let reason: ProviderAbortReason | undefined;
	let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let totalTimer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	};
	const abort = (nextReason: ProviderAbortReason): void => {
		if (controller.signal.aborted) {
			return;
		}
		reason = nextReason;
		controller.abort(nextReason);
	};
	const clientAbort = (): void => abort("client_aborted");
	const armIdleTimer = (): void => {
		clearTimer(idleTimer);
		idleTimer = setTimeout(() => abort("stream_idle_timeout"), timeoutDelay(deadlineAt, limits.streamIdleTimeoutMs));
	};

	if (clientSignal.aborted) {
		abort("client_aborted");
	} else {
		clientSignal.addEventListener("abort", clientAbort, { once: true });
	}
	firstByteTimer = setTimeout(() => abort("first_byte_timeout"), timeoutDelay(deadlineAt, limits.firstByteTimeoutMs));
	totalTimer = setTimeout(() => abort("total_timeout"), Math.max(1, deadlineAt - Date.now()));

	return {
		abort,
		finish() {
			clearTimer(firstByteTimer);
			clearTimer(idleTimer);
			clearTimer(totalTimer);
			clientSignal.removeEventListener("abort", clientAbort);
		},
		markResponseStarted() {
			clearTimer(firstByteTimer);
			firstByteTimer = undefined;
			armIdleTimer();
		},
		get reason() {
			return reason;
		},
		signal: controller.signal,
		touch: armIdleTimer,
	};
}

class SseEventCounter {
	private eventBytes = 0;
	private lineHasContent = false;

	constructor(private readonly maximumBytes: number) {}

	push(chunk: Uint8Array): boolean {
		for (const byte of chunk) {
			this.eventBytes += 1;
			if (this.eventBytes > this.maximumBytes) {
				return false;
			}
			if (byte === 10) {
				if (!this.lineHasContent) {
					this.eventBytes = 0;
				}
				this.lineHasContent = false;
			} else if (byte !== 13) {
				this.lineHasContent = true;
			}
		}
		return true;
	}
}

export function boundedProviderBody(options: {
	body: ReadableStream<Uint8Array>;
	control: ProviderRequestControl;
	isEventStream: boolean;
	limits: ProviderRequestLimits;
	onFinish: () => Promise<void>;
}): ReadableStream<Uint8Array> {
	const reader = options.body.getReader();
	const eventCounter = options.isEventStream ? new SseEventCounter(options.limits.maxSseEventBytes) : undefined;
	let responseBytes = 0;
	let finished = false;
	const finishOnce = async (): Promise<void> => {
		if (finished) {
			return;
		}
		finished = true;
		options.control.finish();
		await options.onFinish();
	};
	const fail = async (reason: ProviderAbortReason): Promise<never> => {
		options.control.abort(reason);
		try {
			await reader.cancel(reason);
		} finally {
			await finishOnce();
		}
		throw new Error(reason);
	};

	return new ReadableStream<Uint8Array>({
		async cancel(reason) {
			options.control.abort("client_aborted");
			try {
				await reader.cancel(reason);
			} finally {
				await finishOnce();
			}
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					await finishOnce();
					return;
				}
				options.control.touch();
				responseBytes += value.byteLength;
				if (responseBytes > options.limits.maxResponseBytes) {
					await fail("response_too_large");
				}
				if (eventCounter && !eventCounter.push(value)) {
					await fail("stream_event_too_large");
				}
				controller.enqueue(value);
			} catch (error) {
				controller.error(error);
				await finishOnce();
			}
		},
	});
}

export async function readBoundedProviderJson(
	body: ReadableStream<Uint8Array> | null,
	control: ProviderRequestControl,
	maxBytes = MAX_LLM_ERROR_BYTES,
): Promise<unknown | undefined> {
	if (!body) {
		return undefined;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			control.touch();
			total += value.byteLength;
			if (total > maxBytes) {
				control.abort("response_too_large");
				await reader.cancel("provider error body too large");
				return undefined;
			}
			chunks.push(value);
		}
	} catch {
		return undefined;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		return undefined;
	}
}
