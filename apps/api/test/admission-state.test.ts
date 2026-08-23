import { describe, expect, it } from "vitest";
import {
	ADMISSION_WINDOW_MS,
	acquireLease,
	emptyAdmissionState,
	GLOBAL_MAX_CONCURRENCY,
	GLOBAL_REQUESTS_PER_WINDOW,
	LEASE_TTL_MS,
	PER_KEY_MAX_CONCURRENCY,
	PER_KEY_REQUESTS_PER_WINDOW,
	releaseLease,
	renewLease,
} from "../src/admission-state";

const NOW = 1_000_000;
const DEADLINE = NOW + 5 * 60_000;

describe("inference admission state", () => {
	it("returns per-key Senko quota metadata and makes acquire idempotent by lease ID", () => {
		const first = acquireLease(emptyAdmissionState(NOW), "key-a", "lease-a", NOW, DEADLINE);
		expect(first.decision).toMatchObject({
			ok: true,
			rateLimit: {
				limitConcurrentRequests: PER_KEY_MAX_CONCURRENCY,
				limitRequests: PER_KEY_REQUESTS_PER_WINDOW,
				remainingConcurrentRequests: PER_KEY_MAX_CONCURRENCY - 1,
				remainingRequests: PER_KEY_REQUESTS_PER_WINDOW - 1,
			},
		});
		const duplicate = acquireLease(first.state, "key-a", "lease-a", NOW, DEADLINE);
		expect(duplicate.decision).toEqual(first.decision);
	});

	it("enforces per-key concurrency and releases leases", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < PER_KEY_MAX_CONCURRENCY; index += 1) {
			const result = acquireLease(state, "key-a", `lease-${index}`, NOW, DEADLINE);
			expect(result.decision.ok).toBe(true);
			state = result.state;
		}
		const denied = acquireLease(state, "key-a", "lease-denied", NOW, DEADLINE);
		expect(denied.decision).toMatchObject({ ok: false, reason: "concurrency_limit" });

		state = releaseLease(denied.state, "lease-0", NOW);
		const allowed = acquireLease(state, "key-a", "lease-after-release", NOW, DEADLINE);
		expect(allowed.decision.ok).toBe(true);
	});

	it("enforces and resets the per-key request window", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < PER_KEY_REQUESTS_PER_WINDOW; index += 1) {
			const result = acquireLease(state, "key-a", `lease-${index}`, NOW, DEADLINE);
			expect(result.decision.ok).toBe(true);
			state = releaseLease(result.state, `lease-${index}`, NOW);
		}
		const denied = acquireLease(state, "key-a", "lease-denied", NOW, DEADLINE);
		expect(denied.decision).toMatchObject({ ok: false, reason: "rate_limit" });
		expect(
			acquireLease(denied.state, "key-a", "lease-next-window", NOW + ADMISSION_WINDOW_MS, DEADLINE).decision.ok,
		).toBe(true);
	});

	it("enforces the global request window across API keys", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < GLOBAL_REQUESTS_PER_WINDOW; index += 1) {
			const leaseId = `lease-${index}`;
			const result = acquireLease(state, `key-${index % 6}`, leaseId, NOW, DEADLINE);
			expect(result.decision.ok).toBe(true);
			state = releaseLease(result.state, leaseId, NOW);
		}
		expect(acquireLease(state, "key-new", "lease-denied", NOW, DEADLINE).decision).toMatchObject({
			ok: false,
			reason: "rate_limit",
		});
	});

	it("enforces global concurrency and expires abandoned leases", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < GLOBAL_MAX_CONCURRENCY; index += 1) {
			const result = acquireLease(state, `key-${index}`, `lease-${index}`, NOW, DEADLINE);
			expect(result.decision.ok).toBe(true);
			state = result.state;
		}
		expect(acquireLease(state, "key-new", "lease-denied", NOW, DEADLINE).decision).toMatchObject({
			ok: false,
			reason: "concurrency_limit",
		});
		expect(acquireLease(state, "key-new", "lease-after-expiry", NOW + LEASE_TTL_MS, DEADLINE).decision.ok).toBe(true);
	});

	it("preserves and migrates active leases written by the previous schema", () => {
		const legacyExpiry = NOW + 60_000;
		const state = emptyAdmissionState(NOW);
		state.leases["legacy-lease"] = { expiresAt: legacyExpiry, keyId: "key-a" };

		const result = acquireLease(state, "key-b", "new-lease", NOW, DEADLINE);

		expect(result.decision.ok).toBe(true);
		expect(result.state.leases["legacy-lease"]).toEqual({
			deadlineAt: legacyExpiry,
			expiresAt: legacyExpiry,
			keyId: "key-a",
		});
		expect(Object.keys(result.state.leases)).toHaveLength(2);
	});

	it("renews leases only until their request deadline", () => {
		const acquired = acquireLease(emptyAdmissionState(NOW), "key-a", "lease-a", NOW, DEADLINE);
		expect(acquired.decision.ok).toBe(true);
		const renewed = renewLease(acquired.state, "lease-a", NOW + LEASE_TTL_MS - 1);
		expect(renewed.renewed).toBe(true);
		expect(renewed.leaseExpiresAt).toBe(NOW + 2 * LEASE_TTL_MS - 1);
		expect(renewLease(renewed.state, "lease-a", DEADLINE).renewed).toBe(false);
	});
});
