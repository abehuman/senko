import { describe, expect, it, vi } from "vitest";
import { durableObjectAdmissionClient } from "../src/admission";
import type { CloudflareBindings } from "../src/types";

const LEASE_ID = `req_${"a".repeat(32)}`;

function envWithAdmissionFetch(fetch: (request: Request) => Promise<Response>): CloudflareBindings {
	return {
		SENKO_ADMISSION: {
			getByName() {
				return { fetch };
			},
		} as unknown as DurableObjectNamespace,
	};
}

describe("Durable Object admission client", () => {
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
