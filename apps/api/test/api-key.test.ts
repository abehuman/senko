import { describe, expect, it } from "vitest";
import { equalHexDigest, generateApiKey, hashApiKey, parseApiKey } from "../src/api-key";

const HASH_SECRET = "test-hash-secret-that-is-at-least-32-bytes-long";

describe("managed API key material", () => {
	it("generates versioned high-entropy keys and stores only derived material", async () => {
		const first = await generateApiKey(HASH_SECRET);
		const second = await generateApiKey(HASH_SECRET);

		expect(first.rawKey).toMatch(/^sk-senko-v1-[A-Za-z0-9_-]{22}-[A-Za-z0-9_-]{43}$/);
		expect(first.publicId).toHaveLength(22);
		expect(first.keyPrefix).toMatch(/^sk-senko-v1-[A-Za-z0-9_-]{8}$/);
		expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(first.hash).not.toContain(first.rawKey);
		expect(first.rawKey).not.toBe(second.rawKey);
		expect(parseApiKey(first.rawKey)).toEqual({ publicId: first.publicId, rawKey: first.rawKey });
	});

	it("uses a keyed deterministic digest and constant-time digest comparison", async () => {
		const key = await generateApiKey(HASH_SECRET);
		const matching = await hashApiKey(key.rawKey, HASH_SECRET);
		const differentSecret = await hashApiKey(key.rawKey, "another-test-hash-secret-with-32-bytes-minimum");

		expect(equalHexDigest(key.hash, matching)).toBe(true);
		expect(equalHexDigest(key.hash, differentSecret)).toBe(false);
		expect(equalHexDigest(key.hash, "invalid")).toBe(false);
	});

	it("rejects malformed and unsupported key versions before lookup", () => {
		expect(parseApiKey("ordinary-secret")).toBeUndefined();
		expect(
			parseApiKey("sk-senko-v2-AAAAAAAAAAAAAAAAAAAAAA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
		).toBeUndefined();
	});
});
