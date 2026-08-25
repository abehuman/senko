export const PROVIDER_POOL_WINDOW_MS = 60_000;
export const PROVIDER_POOL_LEASE_TTL_MS = 90_000;
export const PROVIDER_POOL_RENEW_INTERVAL_MS = 30_000;
export const PROVIDER_POOL_RENEW_RETRY_INTERVAL_MS = 5_000;
export const PROVIDER_POOL_RENEW_SAFETY_MARGIN_MS = 10_000;
export const PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 5;
export const PROVIDER_CIRCUIT_OPEN_MS = 30_000;

export interface ProviderPoolCapacity {
	maxConcurrentRequests: number;
	requestsPerMinute: number;
	tokensPerMinute: number;
}

interface ProviderPoolLease {
	deadlineAt: number;
	expiresAt: number;
	reservedTokens: number;
	windowStartedAt: number;
}

export interface ProviderPoolState {
	circuitOpenUntil: number;
	circuitProbeLeaseId?: string;
	consecutiveFailures: number;
	leases: Record<string, ProviderPoolLease>;
	requests: number;
	tokens: number;
	windowStartedAt: number;
}

export type ProviderPoolDenialReason = "circuit_open" | "concurrency_limit" | "rate_limit" | "token_limit";

export type ProviderPoolDecision =
	| {
			circuitOpenUntil: number;
			leaseExpiresAt: number;
			leaseId: string;
			ok: true;
			remainingConcurrentRequests: number;
			remainingRequests: number;
			remainingTokens: number;
			resetSeconds: number;
	  }
	| {
			circuitOpenUntil: number;
			ok: false;
			reason: ProviderPoolDenialReason;
			remainingConcurrentRequests: number;
			remainingRequests: number;
			remainingTokens: number;
			retryAfterSeconds: number;
			resetSeconds: number;
	  };

export type ProviderPoolReleaseOutcome = "neutral" | "not_started" | "route_failure" | "succeeded";

export interface ProviderPoolReleaseResult {
	circuitOpenUntil: number;
	consecutiveFailures: number;
	released: boolean;
}

export function emptyProviderPoolState(now: number): ProviderPoolState {
	return {
		circuitOpenUntil: 0,
		consecutiveFailures: 0,
		leases: {},
		requests: 0,
		tokens: 0,
		windowStartedAt: now,
	};
}

function normalizedState(state: ProviderPoolState, now: number): ProviderPoolState {
	const next = structuredClone(state);
	next.circuitOpenUntil = Number.isSafeInteger(next.circuitOpenUntil) ? next.circuitOpenUntil : 0;
	next.consecutiveFailures = Number.isSafeInteger(next.consecutiveFailures) ? next.consecutiveFailures : 0;
	next.leases ??= {};
	if (now - next.windowStartedAt >= PROVIDER_POOL_WINDOW_MS || now < next.windowStartedAt) {
		next.requests = 0;
		next.tokens = 0;
		next.windowStartedAt = now;
	}
	for (const [leaseId, lease] of Object.entries(next.leases)) {
		if (
			typeof lease.expiresAt !== "number" ||
			typeof lease.deadlineAt !== "number" ||
			lease.expiresAt <= now ||
			lease.deadlineAt <= now
		) {
			delete next.leases[leaseId];
			continue;
		}
		lease.expiresAt = Math.min(lease.expiresAt, lease.deadlineAt);
	}
	if (next.circuitProbeLeaseId && !next.leases[next.circuitProbeLeaseId]) {
		next.circuitProbeLeaseId = undefined;
	}
	return next;
}

function statusFields(state: ProviderPoolState, capacity: ProviderPoolCapacity, now: number) {
	return {
		circuitOpenUntil: state.circuitOpenUntil,
		remainingConcurrentRequests: Math.max(0, capacity.maxConcurrentRequests - Object.keys(state.leases).length),
		remainingRequests: Math.max(0, capacity.requestsPerMinute - state.requests),
		remainingTokens: Math.max(0, capacity.tokensPerMinute - state.tokens),
		resetSeconds: Math.max(1, Math.ceil((state.windowStartedAt + PROVIDER_POOL_WINDOW_MS - now) / 1000)),
	};
}

export function acquireProviderPoolLease(
	state: ProviderPoolState,
	capacity: ProviderPoolCapacity,
	leaseId: string,
	reservedTokens: number,
	now: number,
	deadlineAt: number,
): { decision: ProviderPoolDecision; state: ProviderPoolState } {
	const next = normalizedState(state, now);
	const existingLease = next.leases[leaseId];
	if (existingLease) {
		return {
			decision: {
				...statusFields(next, capacity, now),
				leaseExpiresAt: existingLease.expiresAt,
				leaseId,
				ok: true,
			},
			state: next,
		};
	}
	const status = statusFields(next, capacity, now);
	if (next.circuitOpenUntil > now || (next.circuitOpenUntil > 0 && next.circuitProbeLeaseId !== undefined)) {
		return {
			decision: {
				...status,
				ok: false,
				reason: "circuit_open",
				retryAfterSeconds: Math.max(1, Math.ceil((next.circuitOpenUntil - now) / 1000)),
			},
			state: next,
		};
	}
	if (Object.keys(next.leases).length >= capacity.maxConcurrentRequests) {
		return {
			decision: { ...status, ok: false, reason: "concurrency_limit", retryAfterSeconds: 1 },
			state: next,
		};
	}
	if (next.requests >= capacity.requestsPerMinute) {
		return {
			decision: { ...status, ok: false, reason: "rate_limit", retryAfterSeconds: status.resetSeconds },
			state: next,
		};
	}
	if (reservedTokens > capacity.tokensPerMinute - next.tokens) {
		return {
			decision: { ...status, ok: false, reason: "token_limit", retryAfterSeconds: status.resetSeconds },
			state: next,
		};
	}

	next.requests += 1;
	next.tokens += reservedTokens;
	next.leases[leaseId] = {
		deadlineAt,
		expiresAt: Math.min(now + PROVIDER_POOL_LEASE_TTL_MS, deadlineAt),
		reservedTokens,
		windowStartedAt: next.windowStartedAt,
	};
	if (next.circuitOpenUntil > 0) {
		next.circuitProbeLeaseId = leaseId;
	}
	return {
		decision: {
			...statusFields(next, capacity, now),
			leaseExpiresAt: next.leases[leaseId].expiresAt,
			leaseId,
			ok: true,
		},
		state: next,
	};
}

export function renewProviderPoolLease(
	state: ProviderPoolState,
	leaseId: string,
	now: number,
): { leaseExpiresAt?: number; renewed: boolean; state: ProviderPoolState } {
	const next = normalizedState(state, now);
	const lease = next.leases[leaseId];
	if (!lease || lease.deadlineAt <= now) {
		return { renewed: false, state: next };
	}
	lease.expiresAt = Math.min(now + PROVIDER_POOL_LEASE_TTL_MS, lease.deadlineAt);
	return { leaseExpiresAt: lease.expiresAt, renewed: true, state: next };
}

export function releaseProviderPoolLease(
	state: ProviderPoolState,
	leaseId: string,
	outcome: ProviderPoolReleaseOutcome,
	now: number,
): { result: ProviderPoolReleaseResult; state: ProviderPoolState } {
	const next = normalizedState(state, now);
	const lease = next.leases[leaseId];
	const released = lease !== undefined;
	const wasCircuitProbe = next.circuitProbeLeaseId === leaseId;
	delete next.leases[leaseId];
	if (wasCircuitProbe) next.circuitProbeLeaseId = undefined;
	if (released && outcome === "not_started" && lease.windowStartedAt === next.windowStartedAt) {
		next.requests = Math.max(0, next.requests - 1);
		next.tokens = Math.max(0, next.tokens - lease.reservedTokens);
	}
	if (wasCircuitProbe) {
		if (outcome === "succeeded") {
			next.consecutiveFailures = 0;
			next.circuitOpenUntil = 0;
		} else if (outcome !== "not_started") {
			next.circuitOpenUntil = now + PROVIDER_CIRCUIT_OPEN_MS;
			next.consecutiveFailures = 0;
		}
	} else if (released && next.circuitOpenUntil === 0) {
		if (outcome === "succeeded") {
			next.consecutiveFailures = 0;
		} else if (outcome === "route_failure") {
			next.consecutiveFailures += 1;
			if (next.consecutiveFailures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD) {
				next.circuitOpenUntil = now + PROVIDER_CIRCUIT_OPEN_MS;
				next.consecutiveFailures = 0;
			}
		}
	}
	return {
		result: {
			circuitOpenUntil: next.circuitOpenUntil,
			consecutiveFailures: next.consecutiveFailures,
			released,
		},
		state: next,
	};
}
