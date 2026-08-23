const encoder = new TextEncoder();

let cachedRawKeys: string | undefined;
let cachedKeyDigests: Promise<Uint8Array[]> | undefined;

function parseKeys(rawKeys: string): string[] {
	return [
		...new Set(
			rawKeys
				.split(/[\n,]/)
				.map((key) => key.trim())
				.filter(Boolean),
		),
	];
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

async function getKeyDigests(rawKeys: string): Promise<Uint8Array[]> {
	if (rawKeys !== cachedRawKeys || !cachedKeyDigests) {
		cachedRawKeys = rawKeys;
		cachedKeyDigests = Promise.all(parseKeys(rawKeys).map(digest));
	}
	return cachedKeyDigests;
}

export async function authenticate(authorization: string | undefined, rawKeys: string | undefined): Promise<boolean> {
	if (!authorization || !rawKeys?.trim()) {
		return false;
	}
	const match = /^Bearer ([^\s]+)$/i.exec(authorization);
	if (!match?.[1]) {
		return false;
	}
	const [candidate, allowed] = await Promise.all([digest(match[1]), getKeyDigests(rawKeys)]);
	let matches = false;
	for (const keyDigest of allowed) {
		matches = equalDigest(candidate, keyDigest) || matches;
	}
	return matches;
}
