import { describe, expect, it, vi } from "vitest";
import { AdmissionController, checkAdmissionDependency, durableObjectAdmissionClient } from "../src/admission";
import type { CloudflareBindings } from "../src/types";

const LEASE_ID = `req_${"a".repeat(32)}`;

function envWithAdmissionFetch(fetch: (request: Request) => Promise<Response>): CloudflareBindings {
	return {
		SENKO_ADMISSION: {
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

describe("Durable Object admission client", () => {
	it("checks the bound controller without acquiring a lease", async () => {
		const get = vi.fn().mockResolvedValue(undefined);
		const controller = new AdmissionController({ storage: { get } } as unknown as DurableObjectState);
		const fetch = vi.fn((request: Request) => controller.fetch(request));

		await expect(checkAdmissionDependency(envWithAdmissionFetch(fetch))).resolves.toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledWith("admission");
	});

	it("accepts database UUID account and key identities", async () => {
		let storedState: unknown;
		const controller = new AdmissionController({
			storage: {
				async transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) {
					return callback({
						async get() {
							return undefined;
						},
						async put(_key: string, value: unknown) {
							storedState = value;
						},
					} as unknown as DurableObjectTransaction);
				},
			},
		} as unknown as DurableObjectState);
		const accountId = "00000000-0000-4000-8000-000000000001";
		const keyId = "00000000-0000-4000-8000-000000000002";
		const response = await controller.fetch(
			new Request("https://senko-admission/acquire", {
				body: JSON.stringify({ accountId, deadlineAt: Date.now() + 60_000, keyId, leaseId: LEASE_ID }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ leaseId: LEASE_ID, ok: true });
		expect(storedState).toMatchObject({ leases: { [LEASE_ID]: { accountId, keyId } } });
	});

	it("retries idempotent release mutations", async () => {
		const fetch = vi
			.fn<(request: Request) => Promise<Response>>()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(durableObjectAdmissionClient.release(envWithAdmissionFetch(fetch), LEASE_ID)).resolves.toBe(true);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("does not retry a renewal for an expired or missing lease", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 404 }));
		await expect(durableObjectAdmissionClient.renew(envWithAdmissionFetch(fetch), LEASE_ID)).resolves.toEqual({
			ok: false,
			reason: "missing",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("reports transient renewal failures separately from missing leases", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 503 }));
		await expect(durableObjectAdmissionClient.renew(envWithAdmissionFetch(fetch), LEASE_ID)).resolves.toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("returns the confirmed expiry from a successful renewal", async () => {
		const leaseExpiresAt = Date.now() + 90_000;
		const fetch = vi.fn(async () => Response.json({ leaseExpiresAt }));
		await expect(durableObjectAdmissionClient.renew(envWithAdmissionFetch(fetch), LEASE_ID)).resolves.toEqual({
			leaseExpiresAt,
			ok: true,
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
