import {
	type AdmissionDecision,
	type AdmissionState,
	acquireLease,
	emptyAdmissionState,
	releaseLease,
} from "./admission-state";
import type { CloudflareBindings } from "./types";

const ADMISSION_OBJECT_NAME = "global";
const STATE_KEY = "admission";

interface AdmissionRequest {
	keyId?: string;
	leaseId: string;
}

export interface AdmissionClient {
	acquire(env: CloudflareBindings, keyId: string, leaseId: string): Promise<AdmissionResult>;
	release(env: CloudflareBindings, leaseId: string): Promise<void>;
}

export type AdmissionResult =
	| AdmissionDecision
	| { ok: false; reason: "admission_unavailable" | "configuration_error"; retryAfterSeconds: number };

function isAdmissionRequest(value: unknown, requireKeyId: boolean): value is AdmissionRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const request = value as Record<string, unknown>;
	return (
		typeof request.leaseId === "string" &&
		/^req_[a-f0-9]{32}$/.test(request.leaseId) &&
		(!requireKeyId || (typeof request.keyId === "string" && /^[a-f0-9]{64}$/.test(request.keyId)))
	);
}

function isAdmissionDecision(value: unknown): value is AdmissionDecision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const decision = value as Record<string, unknown>;
	if (decision.ok === true) {
		return typeof decision.leaseId === "string";
	}
	return (
		decision.ok === false &&
		(decision.reason === "concurrency_limit" || decision.reason === "rate_limit") &&
		typeof decision.retryAfterSeconds === "number"
	);
}

async function parseAdmissionRequest(request: Request, requireKeyId: boolean): Promise<AdmissionRequest | undefined> {
	try {
		const value: unknown = await request.json();
		return isAdmissionRequest(value, requireKeyId) ? value : undefined;
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
		const input = await parseAdmissionRequest(request, pathname === "/acquire");
		if (!input) {
			return new Response("Invalid admission request", { status: 400 });
		}

		if (pathname === "/acquire") {
			const decision = await this.state.storage.transaction(async (transaction) => {
				const now = Date.now();
				const current = (await transaction.get<AdmissionState>(STATE_KEY)) ?? emptyAdmissionState(now);
				const result = acquireLease(current, input.keyId as string, input.leaseId, now);
				await transaction.put(STATE_KEY, result.state);
				return result.decision;
			});
			return Response.json(decision);
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
	path: "/acquire" | "/release",
	input: AdmissionRequest,
): Promise<Response | undefined> {
	if (!env.SENKO_ADMISSION) {
		return undefined;
	}
	try {
		return await env.SENKO_ADMISSION.getByName(ADMISSION_OBJECT_NAME).fetch(`https://senko-admission${path}`, {
			body: JSON.stringify(input),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
	} catch {
		return undefined;
	}
}

export const durableObjectAdmissionClient: AdmissionClient = {
	async acquire(env, keyId, leaseId) {
		if (!env.SENKO_ADMISSION) {
			return { ok: false, reason: "configuration_error", retryAfterSeconds: 1 };
		}
		const response = await callAdmissionController(env, "/acquire", { keyId, leaseId });
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
		await callAdmissionController(env, "/release", { leaseId });
	},
};
