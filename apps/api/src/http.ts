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

export function responseHeaders(llmApiHeaders: Headers, requestId: string): Headers {
	const headers = new Headers({ "cache-control": "no-store", "x-request-id": requestId });
	for (const [name, value] of llmApiHeaders) {
		const normalized = name.toLowerCase();
		if (normalized === "content-type" || normalized === "retry-after" || normalized.startsWith("x-ratelimit-")) {
			headers.set(normalized, value);
		}
	}
	return headers;
}
