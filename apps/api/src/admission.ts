import {
	type AdmissionDecision,
	type AdmissionRateLimit,
	type AdmissionState,
	acquireLease,
	emptyAdmissionState,
	releaseLease,
	renewLease,
} from "./admission-state";
import type { CloudflareBindings } from "./types";

const ADMISSION_OBJECT_NAME = "global";
const ADMISSION_RENEW_ATTEMPT_TIMEOUT_MS = 5_000;
const STATE_KEY = "admission";

interface AdmissionRequest {
	deadlineAt?: number;
	keyId?: string;
	leaseId: string;
}

export interface AdmissionClient {
	acquire(env: CloudflareBindings, keyId: string, leaseId: string, deadlineAt: number): Promise<AdmissionResult>;
	release(env: CloudflareBindings, leaseId: string): Promise<boolean>;
	renew(env: CloudflareBindings, leaseId: string): Promise<AdmissionRenewalResult>;
}

export type AdmissionRenewalResult =
	| { leaseExpiresAt: number; ok: true }
	| { ok: false; reason: "missing" | "unavailable" };

export type AdmissionResult =
	| AdmissionDecision
	| { ok: false; reason: "admission_unavailable" | "configuration_error"; retryAfterSeconds: number };

function isAdmissionRequest(value: unknown, pathname: string): value is AdmissionRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const request = value as Record<string, unknown>;
	return (
		typeof request.leaseId === "string" &&
		/^req_[a-f0-9]{32}$/.test(request.leaseId) &&
		(pathname !== "/acquire" ||
			(typeof request.keyId === "string" &&
				/^[a-f0-9]{64}$/.test(request.keyId) &&
				typeof request.deadlineAt === "number" &&
				Number.isSafeInteger(request.deadlineAt) &&
				request.deadlineAt > 0))
	);
}

function isAdmissionRateLimit(value: unknown): value is AdmissionRateLimit {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	return [
		"limitConcurrentRequests",
		"limitRequests",
		"remainingConcurrentRequests",
		"remainingRequests",
		"resetSeconds",
	].every((field) => typeof (value as Record<string, unknown>)[field] === "number");
}

function isAdmissionDecision(value: unknown): value is AdmissionDecision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const decision = value as Record<string, unknown>;
	if (decision.ok === true) {
		return (
			typeof decision.leaseId === "string" &&
			typeof decision.leaseExpiresAt === "number" &&
			isAdmissionRateLimit(decision.rateLimit)
		);
	}
	return (
		decision.ok === false &&
		(decision.reason === "concurrency_limit" || decision.reason === "rate_limit") &&
		typeof decision.retryAfterSeconds === "number" &&
		isAdmissionRateLimit(decision.rateLimit)
	);
}

async function parseAdmissionRequest(request: Request, pathname: string): Promise<AdmissionRequest | undefined> {
	try {
		const value: unknown = await request.json();
		return isAdmissionRequest(value, pathname) ? value : undefined;
	} catch {
		return undefined;
	}
}

export class AdmissionController implements DurableObject {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		const pathname = new URL(request.url).pathname;
		const input = await parseAdmissionRequest(request, pathname);
		if (!input) {
			return new Response("Invalid admission request", { status: 400 });
		}

		if (pathname === "/acquire") {
			const decision = await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<AdmissionState>(STATE_KEY)) ?? emptyAdmissionState(now);
				const result = acquireLease(current, input.keyId as string, input.leaseId, now, input.deadlineAt as number);
				await transaction.put(STATE_KEY, result.state);
				return result.decision;
			});
			return Response.json(decision);
		}
		if (pathname === "/renew") {
			const renewal = await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<AdmissionState>(STATE_KEY)) ?? emptyAdmissionState(now);
				const result = renewLease(current, input.leaseId, now);
				await transaction.put(STATE_KEY, result.state);
				return result;
			});
			return renewal.renewed
				? Response.json({ leaseExpiresAt: renewal.leaseExpiresAt })
				: new Response(null, { status: 404 });
		}
		if (pathname === "/release") {
			await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<AdmissionState>(STATE_KEY)) ?? emptyAdmissionState(now);
				await transaction.put(STATE_KEY, releaseLease(current, input.leaseId, now));
			});
			return new Response(null, { status: 204 });
		}
		return new Response("Not found", { status: 404 });
	}
}

async function callAdmissionController(
	env: CloudflareBindings,
	path: "/acquire" | "/release" | "/renew",
	input: AdmissionRequest,
	timeoutMs?: number,
): Promise<Response | undefined> {
	if (!env.SENKO_ADMISSION) {
		return undefined;
	}
	const controller = timeoutMs === undefined ? undefined : new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = env.SENKO_ADMISSION.getByName(ADMISSION_OBJECT_NAME).fetch(`https://senko-admission${path}`, {
			body: JSON.stringify(input),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: controller?.signal,
		});
		if (!controller || timeoutMs === undefined) {
			return await response;
		}
		return await Promise.race([
			response,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					controller.abort("admission renewal timeout");
					reject(new Error("admission renewal timeout"));
				}, timeoutMs);
			}),
		]);
	} catch {
		return undefined;
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

function retryDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function releaseAdmissionLease(env: CloudflareBindings, leaseId: string): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await callAdmissionController(env, "/release", { leaseId });
		if (response?.ok) {
			return true;
		}
		if (attempt < 2) {
			await retryDelay(25 * 2 ** attempt);
		}
	}
	return false;
}

async function renewAdmissionLease(env: CloudflareBindings, leaseId: string): Promise<AdmissionRenewalResult> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await callAdmissionController(env, "/renew", { leaseId }, ADMISSION_RENEW_ATTEMPT_TIMEOUT_MS);
		if (response?.status === 404) {
			return { ok: false, reason: "missing" };
		}
		if (response?.ok) {
			try {
				const body: unknown = await response.json();
				if (
					typeof body === "object" &&
					body !== null &&
					!Array.isArray(body) &&
					typeof (body as Record<string, unknown>).leaseExpiresAt === "number"
				) {
					return { leaseExpiresAt: (body as { leaseExpiresAt: number }).leaseExpiresAt, ok: true };
				}
			} catch {
				// Treat malformed admission responses as transient unavailability and retry below.
			}
		}
		if (attempt < 2) {
			await retryDelay(25 * 2 ** attempt);
		}
	}
	return { ok: false, reason: "unavailable" };
}

export const durableObjectAdmissionClient: AdmissionClient = {
	async acquire(env, keyId, leaseId, deadlineAt) {
		if (!env.SENKO_ADMISSION) {
			return { ok: false, reason: "configuration_error", retryAfterSeconds: 1 };
		}
		const response = await callAdmissionController(env, "/acquire", { deadlineAt, keyId, leaseId });
		if (!response?.ok) {
			return { ok: false, reason: "admission_unavailable", retryAfterSeconds: 1 };
		}
		try {
			const decision: unknown = await response.json();
			return isAdmissionDecision(decision)
				? decision
				: { ok: false, reason: "admission_unavailable", retryAfterSeconds: 1 };
		} catch {
			return { ok: false, reason: "admission_unavailable", retryAfterSeconds: 1 };
		}
	},
	async release(env, leaseId) {
		return releaseAdmissionLease(env, leaseId);
	},
	async renew(env, leaseId) {
		return renewAdmissionLease(env, leaseId);
	},
};
