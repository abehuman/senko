const encoder = new TextEncoder();

let cachedRawKeys: string | undefined;
let cachedKeyDigests: Promise<ApiKeyDigest[]> | undefined;

interface ApiKeyDigest {
	digest: Uint8Array;
	id: string;
}

export interface AuthenticatedApiKey {
	id: string;
}

export function bearerToken(authorization: string | undefined): string | undefined {
	if (!authorization) {
		return undefined;
	}
	return /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
}

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

function digestId(value: Uint8Array): string {
	return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function getKeyDigests(rawKeys: string): Promise<ApiKeyDigest[]> {
	if (rawKeys !== cachedRawKeys || !cachedKeyDigests) {
		cachedRawKeys = rawKeys;
		cachedKeyDigests = Promise.all(
			parseKeys(rawKeys).map(async (key) => {
				const keyDigest = await digest(key);
				return { digest: keyDigest, id: digestId(keyDigest) };
			}),
		);
	}
	return cachedKeyDigests;
}

export async function authenticate(
	authorization: string | undefined,
	rawKeys: string | undefined,
): Promise<AuthenticatedApiKey | undefined> {
	if (!authorization || !rawKeys?.trim()) {
		return undefined;
	}
	const token = bearerToken(authorization);
	if (!token) {
		return undefined;
	}
	const [candidate, allowed] = await Promise.all([digest(token), getKeyDigests(rawKeys)]);
	let matchedId: string | undefined;
	for (const key of allowed) {
		if (equalDigest(candidate, key.digest)) {
			matchedId = key.id;
		}
	}
	return matchedId ? { id: matchedId } : undefined;
}

export async function authenticateSecret(
	authorization: string | undefined,
	expectedToken: string | undefined,
): Promise<boolean> {
	const token = bearerToken(authorization);
	if (!token || !expectedToken) {
		return false;
	}
	const [candidate, expected] = await Promise.all([digest(token), digest(expectedToken)]);
	return equalDigest(candidate, expected);
}
