export const ADMISSION_WINDOW_MS = 60_000;
export const GLOBAL_MAX_CONCURRENCY = 12;
export const GLOBAL_REQUESTS_PER_WINDOW = 120;
export const LEASE_TTL_MS = 10 * 60_000;
export const PER_KEY_MAX_CONCURRENCY = 2;
export const PER_KEY_REQUESTS_PER_WINDOW = 20;

interface KeyWindow {
	requests: number;
}

interface Lease {
	expiresAt: number;
	keyId: string;
}

export interface AdmissionState {
	globalRequests: number;
	keys: Record<string, KeyWindow>;
	leases: Record<string, Lease>;
	windowStartedAt: number;
}

export type AdmissionDecision =
	| { ok: true; leaseId: string }
	| { ok: false; reason: "concurrency_limit" | "rate_limit"; retryAfterSeconds: number };

export function emptyAdmissionState(now: number): AdmissionState {
	return { globalRequests: 0, keys: {}, leases: {}, windowStartedAt: now };
}

function normalizedState(state: AdmissionState, now: number): AdmissionState {
	const next = structuredClone(state);
	if (now - next.windowStartedAt >= ADMISSION_WINDOW_MS || now < next.windowStartedAt) {
		next.globalRequests = 0;
		next.keys = {};
		next.windowStartedAt = now;
	}
	for (const [leaseId, lease] of Object.entries(next.leases)) {
		if (lease.expiresAt <= now) {
			delete next.leases[leaseId];
		}
	}
	return next;
}

export function acquireLease(
	state: AdmissionState,
	keyId: string,
	leaseId: string,
	now: number,
): { decision: AdmissionDecision; state: AdmissionState } {
	const next = normalizedState(state, now);
	const keyRequests = next.keys[keyId]?.requests ?? 0;
	const retryAfterSeconds = Math.max(1, Math.ceil((next.windowStartedAt + ADMISSION_WINDOW_MS - now) / 1000));
	if (next.globalRequests >= GLOBAL_REQUESTS_PER_WINDOW || keyRequests >= PER_KEY_REQUESTS_PER_WINDOW) {
		return { decision: { ok: false, reason: "rate_limit", retryAfterSeconds }, state: next };
	}

	const leases = Object.values(next.leases);
	const keyConcurrency = leases.filter((lease) => lease.keyId === keyId).length;
	if (leases.length >= GLOBAL_MAX_CONCURRENCY || keyConcurrency >= PER_KEY_MAX_CONCURRENCY) {
		return {
			decision: { ok: false, reason: "concurrency_limit", retryAfterSeconds: 1 },
			state: next,
		};
	}

	next.globalRequests += 1;
	next.keys[keyId] = { requests: keyRequests + 1 };
	next.leases[leaseId] = { expiresAt: now + LEASE_TTL_MS, keyId };
	return { decision: { leaseId, ok: true }, state: next };
}

export function releaseLease(state: AdmissionState, leaseId: string, now: number): AdmissionState {
	const next = normalizedState(state, now);
	delete next.leases[leaseId];
	return next;
}
