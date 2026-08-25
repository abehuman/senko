import { describe, expect, it, vi } from "vitest";
import {
	checkProviderPoolDependency,
	durableObjectProviderPoolClient,
	ProviderPoolController,
} from "../src/provider-pool";
import type { CloudflareBindings } from "../src/types";

const LEASE_ID = `req_${"a".repeat(32)}`;
const CAPACITY = { maxConcurrentRequests: 2, requestsPerMinute: 10, tokensPerMinute: 1_000 };

function envWithProviderPoolFetch(fetch: (request: Request) => Promise<Response>): CloudflareBindings {
	return {
		SENKO_PROVIDER_POOLS: {
			getByName() {
				return {
					fetch(input: RequestInfo | URL, init?: RequestInit) {
						return fetch(input instanceof Request ? input : new Request(input, init));
					},
				};
			},
		} as unknown as DurableObjectNamespace,
	};
}

describe("Durable Object provider pool", () => {
	it("checks the route-keyed controller without acquiring capacity", async () => {
		const get = vi.fn().mockResolvedValue(undefined);
		const controller = new ProviderPoolController({ storage: { get } } as unknown as DurableObjectState);
		const fetch = vi.fn((request: Request) => controller.fetch(request));

		await expect(checkProviderPoolDependency(envWithProviderPoolFetch(fetch), "singapore-primary")).resolves.toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledWith("provider-pool");
	});

	it("persists route capacity leases in its isolated object", async () => {
		let storedState: unknown;
		const controller = new ProviderPoolController({
			storage: {
				async transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) {
					return callback({
						async get() {
							return storedState;
						},
						async put(_key: string, value: unknown) {
							storedState = value;
						},
					} as unknown as DurableObjectTransaction);
				},
			},
		} as unknown as DurableObjectState);
		const response = await controller.fetch(
			new Request("https://senko-provider-pool/acquire", {
				body: JSON.stringify({
					capacity: CAPACITY,
					deadlineAt: Date.now() + 60_000,
					leaseId: LEASE_ID,
					reservedTokens: 10,
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ leaseId: LEASE_ID, ok: true });
		expect(storedState).toMatchObject({ leases: { [LEASE_ID]: { reservedTokens: 10 } }, requests: 1, tokens: 10 });
	});

	it("uses one Durable Object name per stable route ID", async () => {
		const getByName = vi.fn(() => ({
			fetch: async () => Response.json({ ...capacityDecision(), leaseId: LEASE_ID, ok: true }),
		}));
		const env = { SENKO_PROVIDER_POOLS: { getByName } as unknown as DurableObjectNamespace };
		await durableObjectProviderPoolClient.acquire(
			env,
			"singapore-primary",
			CAPACITY,
			LEASE_ID,
			10,
			Date.now() + 60_000,
		);
		expect(getByName).toHaveBeenCalledWith("singapore-primary");
	});

	it("retries idempotent release and fails closed without the binding", async () => {
		const fetch = vi
			.fn<(request: Request) => Promise<Response>>()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(Response.json({ circuitOpenUntil: 0, consecutiveFailures: 0, released: true }));
		await expect(
			durableObjectProviderPoolClient.release(envWithProviderPoolFetch(fetch), "primary", LEASE_ID, "succeeded"),
		).resolves.toMatchObject({ released: true });
		expect(fetch).toHaveBeenCalledTimes(2);
		await expect(
			durableObjectProviderPoolClient.acquire({}, "primary", CAPACITY, LEASE_ID, 10, Date.now() + 60_000),
		).resolves.toMatchObject({ ok: false, reason: "configuration_error" });
	});
});

function capacityDecision() {
	return {
		circuitOpenUntil: 0,
		leaseExpiresAt: Date.now() + 60_000,
		remainingConcurrentRequests: 1,
		remainingRequests: 9,
		remainingTokens: 990,
		resetSeconds: 60,
	};
}
