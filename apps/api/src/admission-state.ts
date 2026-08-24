export const ADMISSION_WINDOW_MS = 60_000;
export const GLOBAL_MAX_CONCURRENCY = 12;
export const GLOBAL_REQUESTS_PER_WINDOW = 120;
export const LEASE_RENEW_INTERVAL_MS = 30_000;
export const LEASE_RENEW_RETRY_INTERVAL_MS = 5_000;
export const LEASE_RENEW_SAFETY_MARGIN_MS = 10_000;
export const LEASE_TTL_MS = 90_000;
// R0 cost/runaway guardrails only. These are not customer plan entitlements or an enterprise capacity promise.
// Replace them with account-configured limits backed by measured provider capacity and partitioned admission before
// materially raising traffic limits or onboarding large organizations.
export const PER_ACCOUNT_MAX_CONCURRENCY = 6;
export const PER_ACCOUNT_REQUESTS_PER_WINDOW = 60;
export const PER_KEY_MAX_CONCURRENCY = 2;
export const PER_KEY_REQUESTS_PER_WINDOW = 20;

interface AccountWindow {
	requests: number;
}

interface KeyWindow {
	requests: number;
}

interface Lease {
	accountId?: string;
	deadlineAt?: number;
	expiresAt: number;
	keyId: string;
}

export interface AdmissionRateLimit {
	limitConcurrentRequests: number;
	limitRequests: number;
	remainingConcurrentRequests: number;
	remainingRequests: number;
	resetSeconds: number;
}

export interface AdmissionState {
	accounts: Record<string, AccountWindow>;
	globalRequests: number;
	keys: Record<string, KeyWindow>;
	leases: Record<string, Lease>;
	windowStartedAt: number;
}

export type AdmissionDecision =
	| { ok: true; leaseExpiresAt: number; leaseId: string; rateLimit: AdmissionRateLimit }
	| {
			ok: false;
			rateLimit: AdmissionRateLimit;
			reason: "concurrency_limit" | "rate_limit";
			retryAfterSeconds: number;
	  };

export function emptyAdmissionState(now: number): AdmissionState {
	return { accounts: {}, globalRequests: 0, keys: {}, leases: {}, windowStartedAt: now };
}

function normalizedState(state: AdmissionState, now: number): AdmissionState {
	const next = structuredClone(state);
	// Durable Object state may have been written before account-level admission existed.
	next.accounts ??= {};
	if (now - next.windowStartedAt >= ADMISSION_WINDOW_MS || now < next.windowStartedAt) {
		next.accounts = {};
		next.globalRequests = 0;
		next.keys = {};
		next.windowStartedAt = now;
	}
	for (const [leaseId, lease] of Object.entries(next.leases)) {
		if (typeof lease.expiresAt !== "number" || lease.expiresAt <= now) {
			delete next.leases[leaseId];
			continue;
		}
		if (lease.deadlineAt === undefined) {
			lease.deadlineAt = lease.expiresAt;
		}
		if (lease.accountId === undefined) {
			lease.accountId = lease.keyId;
		}
		if (typeof lease.deadlineAt !== "number" || lease.deadlineAt <= now) {
			delete next.leases[leaseId];
			continue;
		}
		lease.expiresAt = Math.min(lease.expiresAt, lease.deadlineAt);
	}
	return next;
}

function rateLimitFor(state: AdmissionState, accountId: string, keyId: string, now: number): AdmissionRateLimit {
	const accountRequests = state.accounts[accountId]?.requests ?? 0;
	const keyRequests = state.keys[keyId]?.requests ?? 0;
	const leases = Object.values(state.leases);
	const accountConcurrency = leases.filter((lease) => lease.accountId === accountId).length;
	const keyConcurrency = leases.filter((lease) => lease.keyId === keyId).length;
	return {
		limitConcurrentRequests: PER_KEY_MAX_CONCURRENCY,
		limitRequests: PER_KEY_REQUESTS_PER_WINDOW,
		remainingConcurrentRequests: Math.max(
			0,
			Math.min(
				PER_KEY_MAX_CONCURRENCY - keyConcurrency,
				PER_ACCOUNT_MAX_CONCURRENCY - accountConcurrency,
				GLOBAL_MAX_CONCURRENCY - leases.length,
			),
		),
		remainingRequests: Math.max(
			0,
			Math.min(
				PER_KEY_REQUESTS_PER_WINDOW - keyRequests,
				PER_ACCOUNT_REQUESTS_PER_WINDOW - accountRequests,
				GLOBAL_REQUESTS_PER_WINDOW - state.globalRequests,
			),
		),
		resetSeconds: Math.max(1, Math.ceil((state.windowStartedAt + ADMISSION_WINDOW_MS - now) / 1000)),
	};
}

export function acquireLease(
	state: AdmissionState,
	accountId: string,
	keyId: string,
	leaseId: string,
	now: number,
	deadlineAt: number,
): { decision: AdmissionDecision; state: AdmissionState } {
	const next = normalizedState(state, now);
	const existingLease = next.leases[leaseId];
	if (existingLease?.accountId === accountId && existingLease.keyId === keyId) {
		return {
			decision: {
				leaseExpiresAt: existingLease.expiresAt,
				leaseId,
				ok: true,
				rateLimit: rateLimitFor(next, accountId, keyId, now),
			},
			state: next,
		};
	}
	if (existingLease) {
		return {
			decision: {
				ok: false,
				rateLimit: rateLimitFor(next, accountId, keyId, now),
				reason: "concurrency_limit",
				retryAfterSeconds: 1,
			},
			state: next,
		};
	}
	const accountRequests = next.accounts[accountId]?.requests ?? 0;
	const keyRequests = next.keys[keyId]?.requests ?? 0;
	const retryAfterSeconds = rateLimitFor(next, accountId, keyId, now).resetSeconds;
	if (
		next.globalRequests >= GLOBAL_REQUESTS_PER_WINDOW ||
		accountRequests >= PER_ACCOUNT_REQUESTS_PER_WINDOW ||
		keyRequests >= PER_KEY_REQUESTS_PER_WINDOW
	) {
		return {
			decision: {
				ok: false,
				rateLimit: rateLimitFor(next, accountId, keyId, now),
				reason: "rate_limit",
				retryAfterSeconds,
			},
			state: next,
		};
	}

	const leases = Object.values(next.leases);
	const accountConcurrency = leases.filter((lease) => lease.accountId === accountId).length;
	const keyConcurrency = leases.filter((lease) => lease.keyId === keyId).length;
	if (
		leases.length >= GLOBAL_MAX_CONCURRENCY ||
		accountConcurrency >= PER_ACCOUNT_MAX_CONCURRENCY ||
		keyConcurrency >= PER_KEY_MAX_CONCURRENCY
	) {
		return {
			decision: {
				ok: false,
				rateLimit: rateLimitFor(next, accountId, keyId, now),
				reason: "concurrency_limit",
				retryAfterSeconds: 1,
			},
			state: next,
		};
	}

	next.globalRequests += 1;
	next.accounts[accountId] = { requests: accountRequests + 1 };
	next.keys[keyId] = { requests: keyRequests + 1 };
	next.leases[leaseId] = { accountId, deadlineAt, expiresAt: Math.min(now + LEASE_TTL_MS, deadlineAt), keyId };
	return {
		decision: {
			leaseExpiresAt: next.leases[leaseId].expiresAt,
			leaseId,
			ok: true,
			rateLimit: rateLimitFor(next, accountId, keyId, now),
		},
		state: next,
	};
}

export function releaseLease(state: AdmissionState, leaseId: string, now: number): AdmissionState {
	const next = normalizedState(state, now);
	delete next.leases[leaseId];
	return next;
}

export function renewLease(
	state: AdmissionState,
	leaseId: string,
	now: number,
): { leaseExpiresAt?: number; renewed: boolean; state: AdmissionState } {
	const next = normalizedState(state, now);
	const lease = next.leases[leaseId];
	if (!lease || lease.deadlineAt === undefined || lease.deadlineAt <= now) {
		return { renewed: false, state: next };
	}
	lease.expiresAt = Math.min(now + LEASE_TTL_MS, lease.deadlineAt);
	return { leaseExpiresAt: lease.expiresAt, renewed: true, state: next };
}
