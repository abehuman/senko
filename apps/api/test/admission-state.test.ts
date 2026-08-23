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
} from "../src/admission-state";

const NOW = 1_000_000;

describe("inference admission state", () => {
	it("enforces per-key concurrency and releases leases", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < PER_KEY_MAX_CONCURRENCY; index += 1) {
			const result = acquireLease(state, "key-a", `lease-${index}`, NOW);
			expect(result.decision.ok).toBe(true);
			state = result.state;
		}
		const denied = acquireLease(state, "key-a", "lease-denied", NOW);
		expect(denied.decision).toMatchObject({ ok: false, reason: "concurrency_limit" });

		state = releaseLease(denied.state, "lease-0", NOW);
		const allowed = acquireLease(state, "key-a", "lease-after-release", NOW);
		expect(allowed.decision.ok).toBe(true);
	});

	it("enforces and resets the per-key request window", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < PER_KEY_REQUESTS_PER_WINDOW; index += 1) {
			const result = acquireLease(state, "key-a", `lease-${index}`, NOW);
			expect(result.decision.ok).toBe(true);
			state = releaseLease(result.state, `lease-${index}`, NOW);
		}
		const denied = acquireLease(state, "key-a", "lease-denied", NOW);
		expect(denied.decision).toMatchObject({ ok: false, reason: "rate_limit" });
		expect(acquireLease(denied.state, "key-a", "lease-next-window", NOW + ADMISSION_WINDOW_MS).decision.ok).toBe(true);
	});

	it("enforces the global request window across API keys", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < GLOBAL_REQUESTS_PER_WINDOW; index += 1) {
			const leaseId = `lease-${index}`;
			const result = acquireLease(state, `key-${index % 6}`, leaseId, NOW);
			expect(result.decision.ok).toBe(true);
			state = releaseLease(result.state, leaseId, NOW);
		}
		expect(acquireLease(state, "key-new", "lease-denied", NOW).decision).toMatchObject({
			ok: false,
			reason: "rate_limit",
		});
	});

	it("enforces global concurrency and expires abandoned leases", () => {
		let state = emptyAdmissionState(NOW);
		for (let index = 0; index < GLOBAL_MAX_CONCURRENCY; index += 1) {
			const result = acquireLease(state, `key-${index}`, `lease-${index}`, NOW);
			expect(result.decision.ok).toBe(true);
			state = result.state;
		}
		expect(acquireLease(state, "key-new", "lease-denied", NOW).decision).toMatchObject({
			ok: false,
			reason: "concurrency_limit",
		});
		expect(acquireLease(state, "key-new", "lease-after-expiry", NOW + LEASE_TTL_MS).decision.ok).toBe(true);
	});
});
