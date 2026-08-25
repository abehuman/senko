import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { ProviderPoolCapacity } from "../src/provider-pool-state";
import type { CloudflareBindings } from "../src/types";

const API_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_TIMEOUT_MS = 30_000;
const CAPACITY: ProviderPoolCapacity = {
	maxConcurrentRequests: 1,
	requestsPerMinute: 10,
	tokensPerMinute: 1_000,
};
const HARNESS_OPTIONS = {
	root: API_ROOT,
	workers: [{ configPath: "wrangler.jsonc" }],
};
const LEGACY_HARNESS_OPTIONS = {
	root: API_ROOT,
	workers: [{ configPath: "wrangler.legacy-state-test.jsonc" }],
};

const server = createTestHarness(HARNESS_OPTIONS);

function leaseId(index: number): string {
	return `req_${index.toString(16).padStart(32, "0")}`;
}

async function admissionRequest(
	env: CloudflareBindings,
	path: "/acquire" | "/release" | "/renew",
	input: Record<string, unknown>,
): Promise<Response> {
	return env.SENKO_ADMISSION?.getByName("global").fetch(`https://senko-admission${path}`, {
		body: JSON.stringify(input),
		headers: { "content-type": "application/json" },
		method: "POST",
	}) as Promise<Response>;
}

async function providerPoolRequest(
	env: CloudflareBindings,
	path: "/acquire" | "/release" | "/renew",
	input: Record<string, unknown>,
): Promise<Response> {
	return env.SENKO_PROVIDER_POOLS?.getByName("singapore-primary").fetch(`https://senko-provider-pool${path}`, {
		body: JSON.stringify(input),
		headers: { "content-type": "application/json" },
		method: "POST",
	}) as Promise<Response>;
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("workerd Durable Object integration", () => {
	beforeAll(async () => {
		await server.listen();
	}, TEST_TIMEOUT_MS);

	afterEach(async () => {
		await server.reset();
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		await server.close();
	}, TEST_TIMEOUT_MS);

	it(
		"serializes concurrent admission and preserves active leases across a Worker reload",
		async () => {
			let env = (await server.getWorker().getEnv()) as CloudflareBindings;
			const accountId = "a".repeat(64);
			const keyId = "b".repeat(64);
			const deadlineAt = Date.now() + 60_000;
			const attempts = await Promise.all(
				[1, 2, 3].map((index) =>
					admissionRequest(env, "/acquire", { accountId, deadlineAt, keyId, leaseId: leaseId(index) }).then(json),
				),
			);
			expect(attempts.filter((attempt) => attempt.ok === true)).toHaveLength(2);
			expect(attempts.filter((attempt) => attempt.reason === "concurrency_limit")).toHaveLength(1);

			await server.update(HARNESS_OPTIONS);
			env = (await server.getWorker().getEnv()) as CloudflareBindings;
			const stillLimited = await json(
				await admissionRequest(env, "/acquire", { accountId, deadlineAt, keyId, leaseId: leaseId(4) }),
			);
			expect(stillLimited).toMatchObject({ ok: false, reason: "concurrency_limit" });

			expect((await admissionRequest(env, "/release", { leaseId: leaseId(1) })).status).toBe(204);
			expect((await admissionRequest(env, "/release", { leaseId: leaseId(1) })).status).toBe(204);
			const admitted = await json(
				await admissionRequest(env, "/acquire", { accountId, deadlineAt, keyId, leaseId: leaseId(4) }),
			);
			expect(admitted).toMatchObject({ ok: true });
		},
		TEST_TIMEOUT_MS,
	);

	it("renews admission and provider leases without extending their request deadline", async () => {
		const env = (await server.getWorker().getEnv()) as CloudflareBindings;
		const deadlineAt = Date.now() + 60_000;
		const admissionLeaseId = leaseId(5);
		const admission = await json(
			await admissionRequest(env, "/acquire", {
				accountId: "c".repeat(64),
				deadlineAt,
				keyId: "d".repeat(64),
				leaseId: admissionLeaseId,
			}),
		);
		expect(admission).toMatchObject({ ok: true });
		const admissionRenewal = await json(await admissionRequest(env, "/renew", { leaseId: admissionLeaseId }));
		expect(admissionRenewal.leaseExpiresAt).toEqual(expect.any(Number));
		expect(admissionRenewal.leaseExpiresAt as number).toBeLessThanOrEqual(deadlineAt);

		const providerLeaseId = leaseId(6);
		const provider = await json(
			await providerPoolRequest(env, "/acquire", {
				capacity: CAPACITY,
				deadlineAt,
				leaseId: providerLeaseId,
				reservedTokens: 10,
			}),
		);
		expect(provider).toMatchObject({ ok: true });
		const providerRenewal = await json(await providerPoolRequest(env, "/renew", { leaseId: providerLeaseId }));
		expect(providerRenewal.leaseExpiresAt).toEqual(expect.any(Number));
		expect(providerRenewal.leaseExpiresAt as number).toBeLessThanOrEqual(deadlineAt);
	});

	it(
		"persists provider capacity and circuit state across a Worker reload",
		async () => {
			let env = (await server.getWorker().getEnv()) as CloudflareBindings;
			const deadlineAt = Date.now() + 60_000;
			const first = await json(
				await providerPoolRequest(env, "/acquire", {
					capacity: CAPACITY,
					deadlineAt,
					leaseId: leaseId(10),
					reservedTokens: 10,
				}),
			);
			expect(first).toMatchObject({ ok: true });
			const capacityDenied = await json(
				await providerPoolRequest(env, "/acquire", {
					capacity: CAPACITY,
					deadlineAt,
					leaseId: leaseId(11),
					reservedTokens: 10,
				}),
			);
			expect(capacityDenied).toMatchObject({ ok: false, reason: "concurrency_limit" });

			for (let index = 0; index < 5; index += 1) {
				const id = leaseId(20 + index);
				await providerPoolRequest(env, "/release", { leaseId: leaseId(10), outcome: "neutral" });
				const acquired = await json(
					await providerPoolRequest(env, "/acquire", {
						capacity: CAPACITY,
						deadlineAt,
						leaseId: id,
						reservedTokens: 10,
					}),
				);
				expect(acquired).toMatchObject({ ok: true });
				await providerPoolRequest(env, "/release", { leaseId: id, outcome: "route_failure" });
			}

			await server.update(HARNESS_OPTIONS);
			env = (await server.getWorker().getEnv()) as CloudflareBindings;
			const circuitOpen = await json(
				await providerPoolRequest(env, "/acquire", {
					capacity: CAPACITY,
					deadlineAt,
					leaseId: leaseId(30),
					reservedTokens: 10,
				}),
			);
			expect(circuitOpen).toMatchObject({ ok: false, reason: "circuit_open" });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"preserves active admission and provider leases across Durable Object eviction",
		async () => {
			const worker = server.getWorker<CloudflareBindings>();
			const env = await worker.getEnv();
			const deadlineAt = Date.now() + 60_000;
			const accountId = "e".repeat(64);
			const keyId = "f".repeat(64);

			for (const index of [40, 41]) {
				const admitted = await json(
					await admissionRequest(env, "/acquire", {
						accountId,
						deadlineAt,
						keyId,
						leaseId: leaseId(index),
					}),
				);
				expect(admitted).toMatchObject({ ok: true });
			}

			await worker.evictDurableObject("SENKO_ADMISSION", { name: "global" });
			const admissionDenied = await json(
				await admissionRequest(env, "/acquire", {
					accountId,
					deadlineAt,
					keyId,
					leaseId: leaseId(42),
				}),
			);
			expect(admissionDenied).toMatchObject({ ok: false, reason: "concurrency_limit" });

			const providerLeaseId = leaseId(43);
			const providerAdmitted = await json(
				await providerPoolRequest(env, "/acquire", {
					capacity: CAPACITY,
					deadlineAt,
					leaseId: providerLeaseId,
					reservedTokens: 10,
				}),
			);
			expect(providerAdmitted).toMatchObject({ ok: true });

			await worker.evictDurableObject("SENKO_PROVIDER_POOLS", { name: "singapore-primary" });
			const providerDenied = await json(
				await providerPoolRequest(env, "/acquire", {
					capacity: CAPACITY,
					deadlineAt,
					leaseId: leaseId(44),
					reservedTokens: 10,
				}),
			);
			expect(providerDenied).toMatchObject({ ok: false, reason: "concurrency_limit" });

			expect((await admissionRequest(env, "/release", { leaseId: leaseId(40) })).status).toBe(204);
			const providerReleased = await json(
				await providerPoolRequest(env, "/release", { leaseId: providerLeaseId, outcome: "neutral" }),
			);
			expect(providerReleased).toMatchObject({ released: true });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"migrates a persisted admission lease written by the legacy Worker schema",
		async () => {
			const legacyServer = createTestHarness(LEGACY_HARNESS_OPTIONS);
			await legacyServer.listen();
			try {
				const legacyEnv = (await legacyServer.getWorker().getEnv()) as CloudflareBindings;
				const legacyLeaseId = leaseId(45);
				const legacyKeyId = "9".repeat(64);
				const expiresAt = Date.now() + 60_000;
				const seeded = await legacyEnv.SENKO_ADMISSION?.getByName("global").fetch("https://senko-admission/seed", {
					body: JSON.stringify({
						globalRequests: 1,
						keys: { [legacyKeyId]: { requests: 1 } },
						leases: { [legacyLeaseId]: { expiresAt, keyId: legacyKeyId } },
						windowStartedAt: Date.now(),
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				});
				expect(seeded?.status).toBe(204);

				await legacyServer.update(HARNESS_OPTIONS);
				const currentEnv = (await legacyServer.getWorker().getEnv()) as CloudflareBindings;
				const renewal = await json(await admissionRequest(currentEnv, "/renew", { leaseId: legacyLeaseId }));
				expect(renewal.leaseExpiresAt).toBe(expiresAt);

				const sameLegacyIdentity = await json(
					await admissionRequest(currentEnv, "/acquire", {
						accountId: legacyKeyId,
						deadlineAt: expiresAt,
						keyId: legacyKeyId,
						leaseId: legacyLeaseId,
					}),
				);
				expect(sameLegacyIdentity).toMatchObject({ leaseExpiresAt: expiresAt, ok: true });
			} finally {
				await legacyServer.close();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it("reclaims admission and provider capacity after the request deadline", async () => {
		const env = await server.getWorker<CloudflareBindings>().getEnv();
		const deadlineAt = Date.now() + 50;
		const accountId = "1".repeat(64);
		const keyId = "2".repeat(64);

		for (const index of [50, 51]) {
			const admitted = await json(
				await admissionRequest(env, "/acquire", {
					accountId,
					deadlineAt,
					keyId,
					leaseId: leaseId(index),
				}),
			);
			expect(admitted).toMatchObject({ ok: true });
		}

		const providerLeaseId = leaseId(52);
		const providerAdmitted = await json(
			await providerPoolRequest(env, "/acquire", {
				capacity: CAPACITY,
				deadlineAt,
				leaseId: providerLeaseId,
				reservedTokens: 10,
			}),
		);
		expect(providerAdmitted).toMatchObject({ ok: true });

		await new Promise((resolve) => setTimeout(resolve, 75));

		expect((await admissionRequest(env, "/renew", { leaseId: leaseId(50) })).status).toBe(404);
		expect((await providerPoolRequest(env, "/renew", { leaseId: providerLeaseId })).status).toBe(404);

		const admissionReclaimed = await json(
			await admissionRequest(env, "/acquire", {
				accountId,
				deadlineAt: Date.now() + 60_000,
				keyId,
				leaseId: leaseId(53),
			}),
		);
		expect(admissionReclaimed).toMatchObject({ ok: true });

		const providerReclaimed = await json(
			await providerPoolRequest(env, "/acquire", {
				capacity: CAPACITY,
				deadlineAt: Date.now() + 60_000,
				leaseId: leaseId(54),
				reservedTokens: 10,
			}),
		);
		expect(providerReclaimed).toMatchObject({ ok: true });
	});
});
