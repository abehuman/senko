import { describe, expect, it } from "vitest";
import {
	acquireProviderPoolLease,
	emptyProviderPoolState,
	PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
	PROVIDER_CIRCUIT_OPEN_MS,
	PROVIDER_POOL_LEASE_TTL_MS,
	releaseProviderPoolLease,
	renewProviderPoolLease,
} from "../src/provider-pool-state";

const CAPACITY = { maxConcurrentRequests: 2, requestsPerMinute: 3, tokensPerMinute: 100 };
const LEASE_ID = `req_${"a".repeat(32)}`;

describe("provider pool state", () => {
	it("enforces concurrency, RPM, and TPM independently", () => {
		const now = 1_000_000;
		const first = acquireProviderPoolLease(emptyProviderPoolState(now), CAPACITY, LEASE_ID, 40, now, now + 120_000);
		expect(first.decision).toMatchObject({
			ok: true,
			remainingConcurrentRequests: 1,
			remainingRequests: 2,
			remainingTokens: 60,
		});

		const second = acquireProviderPoolLease(
			first.state,
			{ ...CAPACITY, maxConcurrentRequests: 1 },
			`req_${"b".repeat(32)}`,
			10,
			now,
			now + 120_000,
		);
		expect(second.decision).toMatchObject({ ok: false, reason: "concurrency_limit" });

		const released = releaseProviderPoolLease(first.state, LEASE_ID, "neutral", now).state;
		const tokenDenied = acquireProviderPoolLease(released, CAPACITY, `req_${"c".repeat(32)}`, 61, now, now + 120_000);
		expect(tokenDenied.decision).toMatchObject({ ok: false, reason: "token_limit" });

		let requestLimited = released;
		for (const suffix of ["d", "e"]) {
			const acquired = acquireProviderPoolLease(
				requestLimited,
				CAPACITY,
				`req_${suffix.repeat(32)}`,
				1,
				now,
				now + 120_000,
			);
			expect(acquired.decision.ok).toBe(true);
			requestLimited = releaseProviderPoolLease(acquired.state, `req_${suffix.repeat(32)}`, "neutral", now).state;
		}
		const denied = acquireProviderPoolLease(requestLimited, CAPACITY, `req_${"f".repeat(32)}`, 1, now, now + 120_000);
		expect(denied.decision).toMatchObject({ ok: false, reason: "rate_limit" });
	});

	it("renews leases up to the server deadline and expires stale leases", () => {
		const now = 2_000_000;
		const deadlineAt = now + 3 * PROVIDER_POOL_LEASE_TTL_MS;
		const acquired = acquireProviderPoolLease(emptyProviderPoolState(now), CAPACITY, LEASE_ID, 10, now, deadlineAt);
		const renewed = renewProviderPoolLease(acquired.state, LEASE_ID, now + PROVIDER_POOL_LEASE_TTL_MS - 1);
		expect(renewed.renewed).toBe(true);
		expect(renewed.leaseExpiresAt).toBe(now + 2 * PROVIDER_POOL_LEASE_TTL_MS - 1);

		const expired = renewProviderPoolLease(renewed.state, LEASE_ID, deadlineAt);
		expect(expired).toMatchObject({ renewed: false });
	});

	it("opens a circuit after consecutive route failures and resets on success", () => {
		const now = 3_000_000;
		const circuitCapacity = { ...CAPACITY, requestsPerMinute: 10 };
		let state = emptyProviderPoolState(now);
		for (let index = 0; index < PROVIDER_CIRCUIT_FAILURE_THRESHOLD; index += 1) {
			const leaseId = `req_${index.toString(16).padStart(32, "0")}`;
			const acquired = acquireProviderPoolLease(state, circuitCapacity, leaseId, 1, now + index, now + 120_000);
			expect(acquired.decision.ok).toBe(true);
			state = releaseProviderPoolLease(acquired.state, leaseId, "route_failure", now + index).state;
		}
		expect(state.circuitOpenUntil).toBe(now + PROVIDER_CIRCUIT_FAILURE_THRESHOLD - 1 + PROVIDER_CIRCUIT_OPEN_MS);
		const denied = acquireProviderPoolLease(state, circuitCapacity, LEASE_ID, 1, now + 10, now + 120_000);
		expect(denied.decision).toMatchObject({ ok: false, reason: "circuit_open" });

		const afterOpen = state.circuitOpenUntil + 1;
		const probe = acquireProviderPoolLease(state, circuitCapacity, LEASE_ID, 1, afterOpen, afterOpen + 120_000);
		expect(probe.decision.ok).toBe(true);
		const competingProbe = acquireProviderPoolLease(
			probe.state,
			circuitCapacity,
			`req_${"f".repeat(32)}`,
			1,
			afterOpen,
			afterOpen + 120_000,
		);
		expect(competingProbe.decision).toMatchObject({ ok: false, reason: "circuit_open" });
		state = releaseProviderPoolLease(probe.state, LEASE_ID, "succeeded", afterOpen).state;
		expect(state).toMatchObject({ circuitOpenUntil: 0, consecutiveFailures: 0 });
	});

	it("refunds route capacity when no provider request started", () => {
		const now = 5_000_000;
		const acquired = acquireProviderPoolLease(emptyProviderPoolState(now), CAPACITY, LEASE_ID, 25, now, now + 120_000);
		const released = releaseProviderPoolLease(acquired.state, LEASE_ID, "not_started", now + 1);
		expect(released.state).toMatchObject({ requests: 0, tokens: 0 });
	});

	it("does not let a late non-probe success close a newly opened circuit", () => {
		const now = 6_000_000;
		const capacity = { maxConcurrentRequests: 10, requestsPerMinute: 20, tokensPerMinute: 1_000 };
		let state = emptyProviderPoolState(now);
		const leaseIds = Array.from(
			{ length: PROVIDER_CIRCUIT_FAILURE_THRESHOLD + 1 },
			(_, index) => `req_${index.toString(16).padStart(32, "0")}`,
		);
		for (const leaseId of leaseIds) {
			const acquired = acquireProviderPoolLease(state, capacity, leaseId, 1, now, now + 120_000);
			expect(acquired.decision.ok).toBe(true);
			state = acquired.state;
		}
		for (const leaseId of leaseIds.slice(0, PROVIDER_CIRCUIT_FAILURE_THRESHOLD)) {
			state = releaseProviderPoolLease(state, leaseId, "route_failure", now + 1).state;
		}
		const circuitOpenUntil = state.circuitOpenUntil;
		expect(circuitOpenUntil).toBeGreaterThan(now);

		state = releaseProviderPoolLease(state, leaseIds.at(-1) as string, "succeeded", now + 2).state;
		expect(state.circuitOpenUntil).toBe(circuitOpenUntil);
		const denied = acquireProviderPoolLease(state, capacity, LEASE_ID, 1, now + 3, now + 120_000);
		expect(denied.decision).toMatchObject({ ok: false, reason: "circuit_open" });
	});

	it("keeps acquire and release idempotent", () => {
		const now = 4_000_000;
		const first = acquireProviderPoolLease(emptyProviderPoolState(now), CAPACITY, LEASE_ID, 10, now, now + 120_000);
		const duplicate = acquireProviderPoolLease(first.state, CAPACITY, LEASE_ID, 10, now + 1, now + 120_000);
		expect(duplicate.decision).toMatchObject({ ok: true });
		expect(duplicate.state).toMatchObject({ requests: 1, tokens: 10 });

		const released = releaseProviderPoolLease(duplicate.state, LEASE_ID, "route_failure", now + 2);
		expect(released.result).toMatchObject({ consecutiveFailures: 1, released: true });
		const duplicateRelease = releaseProviderPoolLease(released.state, LEASE_ID, "route_failure", now + 3);
		expect(duplicateRelease.result).toMatchObject({ consecutiveFailures: 1, released: false });
	});
});
