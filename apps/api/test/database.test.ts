import { describe, expect, it, vi } from "vitest";
import { type DatabaseClient, getDatabaseConfig, withDatabaseClient } from "../src/database";

const DATABASE_URL =
	"postgresql://runtime-user:runtime-password@example.invalid/senko?uselibpqcompat=true&sslmode=require";
const HASH_SECRET = "test-hash-secret-that-is-at-least-32-bytes-long";

describe("Worker database connection", () => {
	it("requires the dedicated runtime URL, keyed-hash secret, and Railway TLS parameters", () => {
		expect(getDatabaseConfig({ SENKO_DATABASE_URL: DATABASE_URL, SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET })).toEqual({
			connectionString: DATABASE_URL,
			hashSecret: HASH_SECRET,
			ok: true,
		});
		expect(getDatabaseConfig({ SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET })).toMatchObject({ ok: false });
		expect(
			getDatabaseConfig({
				SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET,
				SENKO_DATABASE_URL: "postgresql://user:password@example.invalid/senko?sslmode=require",
			}),
		).toMatchObject({ message: expect.stringContaining("uselibpqcompat"), ok: false });
	});

	it("opens one direct client for an operation and always closes it", async () => {
		const connect = vi.fn().mockResolvedValue(undefined);
		const end = vi.fn().mockResolvedValue(undefined);
		const query = vi.fn().mockResolvedValue({ rows: [{ value: 1 }] });
		const client = { connect, end, query } as unknown as DatabaseClient;
		const factory = vi.fn(() => client);

		await expect(
			withDatabaseClient(DATABASE_URL, async (database) => (await database.query("select 1")).rows[0], factory),
		).resolves.toEqual({ value: 1 });
		expect(connect).toHaveBeenCalledOnce();
		expect(end).toHaveBeenCalledOnce();
		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({ application_name: "senko-api-worker", connectionString: DATABASE_URL }),
		);
	});

	it("closes a connected client when the operation fails", async () => {
		const end = vi.fn().mockResolvedValue(undefined);
		const client = {
			connect: vi.fn().mockResolvedValue(undefined),
			end,
			query: vi.fn(),
		} as unknown as DatabaseClient;
		await expect(
			withDatabaseClient(
				DATABASE_URL,
				async () => {
					throw new Error("operation failed");
				},
				() => client,
			),
		).rejects.toThrow("operation failed");
		expect(end).toHaveBeenCalledOnce();
	});
});
