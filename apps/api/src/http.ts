import type { AdmissionRateLimit } from "./admission-state";

export interface ApiErrorOptions {
	code: string;
	message: string;
	param?: string | null;
	requestId: string;
	status: number;
	type: string;
}

export function apiError(options: ApiErrorOptions): Response {
	return Response.json(
		{
			error: {
				code: options.code,
				message: options.message,
				param: options.param ?? null,
				type: options.type,
			},
		},
		{
			headers: { "cache-control": "no-store", "x-request-id": options.requestId },
			status: options.status,
		},
	);
}

export function applyRateLimitHeaders(headers: Headers, rateLimit: AdmissionRateLimit): void {
	headers.set("x-ratelimit-limit-concurrent-requests", String(rateLimit.limitConcurrentRequests));
	headers.set("x-ratelimit-limit-requests", String(rateLimit.limitRequests));
	headers.set("x-ratelimit-remaining-concurrent-requests", String(rateLimit.remainingConcurrentRequests));
	headers.set("x-ratelimit-remaining-requests", String(rateLimit.remainingRequests));
	headers.set("x-ratelimit-reset-requests", `${rateLimit.resetSeconds}s`);
}

export function responseHeaders(llmApiHeaders: Headers, requestId: string, rateLimit?: AdmissionRateLimit): Headers {
	const headers = new Headers({ "cache-control": "no-store", "x-request-id": requestId });
	for (const [name, value] of llmApiHeaders) {
		const normalized = name.toLowerCase();
		if (normalized === "content-type" || normalized === "retry-after") {
			headers.set(normalized, value);
		}
	}
	if (rateLimit) {
		applyRateLimitHeaders(headers, rateLimit);
	}
	return headers;
}
