import {
	acquireProviderPoolLease,
	emptyProviderPoolState,
	type ProviderPoolCapacity,
	type ProviderPoolDecision,
	type ProviderPoolReleaseOutcome,
	type ProviderPoolReleaseResult,
	type ProviderPoolState,
	releaseProviderPoolLease,
	renewProviderPoolLease,
} from "./provider-pool-state";
import type { CloudflareBindings } from "./types";

const STATE_KEY = "provider-pool";
const PROVIDER_POOL_ATTEMPT_TIMEOUT_MS = 5_000;
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface AcquireRequest {
	capacity: ProviderPoolCapacity;
	deadlineAt: number;
	leaseId: string;
	reservedTokens: number;
}

interface LeaseRequest {
	leaseId: string;
	outcome?: ProviderPoolReleaseOutcome;
}

export type ProviderPoolAcquireResult =
	| ProviderPoolDecision
	| { ok: false; reason: "configuration_error" | "provider_pool_unavailable"; retryAfterSeconds: number };

export type ProviderPoolRenewalResult =
	| { leaseExpiresAt: number; ok: true }
	| { ok: false; reason: "missing" | "unavailable" };

export interface ProviderPoolClient {
	acquire(
		env: CloudflareBindings,
		routeId: string,
		capacity: ProviderPoolCapacity,
		leaseId: string,
		reservedTokens: number,
		deadlineAt: number,
	): Promise<ProviderPoolAcquireResult>;
	release(
		env: CloudflareBindings,
		routeId: string,
		leaseId: string,
		outcome: ProviderPoolReleaseOutcome,
	): Promise<ProviderPoolReleaseResult | undefined>;
	renew(env: CloudflareBindings, routeId: string, leaseId: string): Promise<ProviderPoolRenewalResult>;
}

export async function checkProviderPoolDependency(env: CloudflareBindings, routeId: string): Promise<boolean> {
	if (!env.SENKO_PROVIDER_POOLS || !ROUTE_ID_PATTERN.test(routeId)) return false;
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort("provider pool dependency timeout"),
		PROVIDER_POOL_ATTEMPT_TIMEOUT_MS,
	);
	try {
		const response = await env.SENKO_PROVIDER_POOLS.getByName(routeId).fetch("https://senko-provider-pool/health", {
			signal: controller.signal,
		});
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isLeaseId(value: unknown): value is string {
	return typeof value === "string" && /^req_[a-f0-9]{32}$/.test(value);
}

function isCapacity(value: unknown): value is ProviderPoolCapacity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const capacity = value as Record<string, unknown>;
	return (
		isPositiveSafeInteger(capacity.maxConcurrentRequests) &&
		isPositiveSafeInteger(capacity.requestsPerMinute) &&
		isPositiveSafeInteger(capacity.tokensPerMinute)
	);
}

function isAcquireRequest(value: unknown): value is AcquireRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	return (
		isCapacity(request.capacity) &&
		isPositiveSafeInteger(request.deadlineAt) &&
		isLeaseId(request.leaseId) &&
		isPositiveSafeInteger(request.reservedTokens)
	);
}

function isLeaseRequest(value: unknown, requiresOutcome: boolean): value is LeaseRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	return (
		isLeaseId(request.leaseId) &&
		(!requiresOutcome ||
			request.outcome === "neutral" ||
			request.outcome === "not_started" ||
			request.outcome === "route_failure" ||
			request.outcome === "succeeded")
	);
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

export class ProviderPoolController implements DurableObject {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (request.method === "GET" && pathname === "/health") {
			await this.state.storage.get(STATE_KEY);
			return Response.json({ status: "ok" });
		}
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const input = await readJson(request);
		if (pathname === "/acquire") {
			if (!isAcquireRequest(input)) return new Response("Invalid provider pool request", { status: 400 });
			const decision = await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<ProviderPoolState>(STATE_KEY)) ?? emptyProviderPoolState(now);
				const result = acquireProviderPoolLease(
					current,
					input.capacity,
					input.leaseId,
					input.reservedTokens,
					now,
					input.deadlineAt,
				);
				await transaction.put(STATE_KEY, result.state);
				return result.decision;
			});
			return Response.json(decision);
		}
		if (pathname === "/renew") {
			if (!isLeaseRequest(input, false)) return new Response("Invalid provider pool request", { status: 400 });
			const renewal = await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<ProviderPoolState>(STATE_KEY)) ?? emptyProviderPoolState(now);
				const result = renewProviderPoolLease(current, input.leaseId, now);
				await transaction.put(STATE_KEY, result.state);
				return result;
			});
			return renewal.renewed
				? Response.json({ leaseExpiresAt: renewal.leaseExpiresAt })
				: new Response(null, { status: 404 });
		}
		if (pathname === "/release") {
			if (!isLeaseRequest(input, true)) return new Response("Invalid provider pool request", { status: 400 });
			const result = await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<ProviderPoolState>(STATE_KEY)) ?? emptyProviderPoolState(now);
				const released = releaseProviderPoolLease(
					current,
					input.leaseId,
					input.outcome as ProviderPoolReleaseOutcome,
					now,
				);
				await transaction.put(STATE_KEY, released.state);
				return released.result;
			});
			return Response.json(result);
		}
		return new Response("Not found", { status: 404 });
	}
}

async function callProviderPool(
	env: CloudflareBindings,
	routeId: string,
	path: "/acquire" | "/release" | "/renew",
	body: AcquireRequest | LeaseRequest,
): Promise<Response | undefined> {
	if (!env.SENKO_PROVIDER_POOLS || !ROUTE_ID_PATTERN.test(routeId)) return undefined;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort("provider pool timeout"), PROVIDER_POOL_ATTEMPT_TIMEOUT_MS);
	try {
		return await env.SENKO_PROVIDER_POOLS.getByName(routeId).fetch(`https://senko-provider-pool${path}`, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: controller.signal,
		});
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function retryDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAcquireDecision(value: unknown): value is ProviderPoolDecision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const decision = value as Record<string, unknown>;
	if (typeof decision.ok !== "boolean") return false;
	for (const field of [
		"circuitOpenUntil",
		"remainingConcurrentRequests",
		"remainingRequests",
		"remainingTokens",
		"resetSeconds",
	]) {
		if (typeof decision[field] !== "number" || !Number.isSafeInteger(decision[field])) return false;
	}
	if (decision.ok) {
		return typeof decision.leaseId === "string" && typeof decision.leaseExpiresAt === "number";
	}
	return (
		(decision.reason === "circuit_open" ||
			decision.reason === "concurrency_limit" ||
			decision.reason === "rate_limit" ||
			decision.reason === "token_limit") &&
		typeof decision.retryAfterSeconds === "number"
	);
}

function isReleaseResult(value: unknown): value is ProviderPoolReleaseResult {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).circuitOpenUntil === "number" &&
		typeof (value as Record<string, unknown>).consecutiveFailures === "number" &&
		typeof (value as Record<string, unknown>).released === "boolean"
	);
}

export const durableObjectProviderPoolClient: ProviderPoolClient = {
	async acquire(env, routeId, capacity, leaseId, reservedTokens, deadlineAt) {
		if (!env.SENKO_PROVIDER_POOLS) {
			return { ok: false, reason: "configuration_error", retryAfterSeconds: 1 };
		}
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const response = await callProviderPool(env, routeId, "/acquire", {
				capacity,
				deadlineAt,
				leaseId,
				reservedTokens,
			});
			if (response?.ok) {
				try {
					const decision: unknown = await response.json();
					if (isAcquireDecision(decision)) return decision;
				} catch {
					// Retry malformed or unavailable responses below.
				}
			}
			if (attempt < 2) await retryDelay(25 * 2 ** attempt);
		}
		return { ok: false, reason: "provider_pool_unavailable", retryAfterSeconds: 1 };
	},
	async release(env, routeId, leaseId, outcome) {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const response = await callProviderPool(env, routeId, "/release", { leaseId, outcome });
			if (response?.ok) {
				try {
					const result: unknown = await response.json();
					if (isReleaseResult(result)) return result;
				} catch {
					// Retry malformed or unavailable responses below.
				}
			}
			if (attempt < 2) await retryDelay(25 * 2 ** attempt);
		}
		return undefined;
	},
	async renew(env, routeId, leaseId) {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const response = await callProviderPool(env, routeId, "/renew", { leaseId });
			if (response?.status === 404) return { ok: false, reason: "missing" };
			if (response?.ok) {
				try {
					const result: unknown = await response.json();
					if (
						typeof result === "object" &&
						result !== null &&
						!Array.isArray(result) &&
						typeof (result as Record<string, unknown>).leaseExpiresAt === "number"
					) {
						return { leaseExpiresAt: (result as { leaseExpiresAt: number }).leaseExpiresAt, ok: true };
					}
				} catch {
					// Retry malformed or unavailable responses below.
				}
			}
			if (attempt < 2) await retryDelay(25 * 2 ** attempt);
		}
		return { ok: false, reason: "unavailable" };
	},
};
