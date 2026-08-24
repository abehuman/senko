import type { ApiKeyScope } from "./db/schema";

const API_KEY_PUBLIC_ID_BYTES = 16;
const API_KEY_SECRET_BYTES = 32;
const API_KEY_VERSION = 1;
const API_KEY_PREFIX = `sk-senko-v${API_KEY_VERSION}`;
const API_KEY_PATTERN = /^sk-senko-v1-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();

let cachedHashSecret: string | undefined;
let cachedHashKey: Promise<CryptoKey> | undefined;

export interface GeneratedApiKey {
	hash: string;
	hashVersion: number;
	keyPrefix: string;
	publicId: string;
	rawKey: string;
}

export interface ParsedApiKey {
	publicId: string;
	rawKey: string;
}

export const API_KEY_SCOPES = [
	"models:read",
	"inference:chat",
	"inference:responses",
] as const satisfies readonly ApiKeyScope[];

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashKey(secret: string): Promise<CryptoKey> {
	if (secret !== cachedHashSecret || !cachedHashKey) {
		cachedHashSecret = secret;
		cachedHashKey = crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
			"sign",
		]);
	}
	return cachedHashKey;
}

export async function hashApiKey(rawKey: string, hashSecret: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await hashKey(hashSecret), encoder.encode(rawKey));
	return hex(signature);
}

export function parseApiKey(rawKey: string): ParsedApiKey | undefined {
	const match = API_KEY_PATTERN.exec(rawKey);
	return match?.[1] ? { publicId: match[1], rawKey } : undefined;
}

export async function generateApiKey(hashSecret: string): Promise<GeneratedApiKey> {
	const publicId = randomBase64Url(API_KEY_PUBLIC_ID_BYTES);
	const rawKey = `${API_KEY_PREFIX}-${publicId}-${randomBase64Url(API_KEY_SECRET_BYTES)}`;
	return {
		hash: await hashApiKey(rawKey, hashSecret),
		hashVersion: API_KEY_VERSION,
		keyPrefix: `${API_KEY_PREFIX}-${publicId.slice(0, 8)}`,
		publicId,
		rawKey,
	};
}

export function equalHexDigest(left: string, right: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}
