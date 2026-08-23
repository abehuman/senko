export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: "invalid_json" | "request_too_large" };

function declaredBodyIsTooLarge(request: Request, maxBytes: number): boolean {
	const rawLength = request.headers.get("content-length");
	if (!rawLength) {
		return false;
	}
	const length = Number(rawLength);
	return Number.isFinite(length) && length > maxBytes;
}

export async function readBoundedJson(request: Request, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<JsonBodyResult> {
	if (declaredBodyIsTooLarge(request, maxBytes)) {
		return { ok: false, reason: "request_too_large" };
	}
	if (!request.body) {
		return { ok: false, reason: "invalid_json" };
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel("request body too large");
				return { ok: false, reason: "request_too_large" };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: "invalid_json" };
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, reason: "invalid_json" };
	}
}
