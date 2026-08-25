import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresIdentityService } from "../src/identity";
import type { CloudflareBindings, ModelPricing } from "../src/types";
import { createPostgresUsageService } from "../src/usage";

const TEST_RAILWAY_SERVICE_ID = "93f9494a-0e1b-4177-b84d-b24ac9b88b5f";
const INTERRUPTED_TEST_ACCOUNT_NAME = "Rotation integration test";
const HASH_SECRET = "senko-postgres-rotation-integration-secret-v1";
const MIGRATIONS = [
	"0000_iam_foundation.sql",
	"0001_fine_rockslide.sql",
	"0002_complete_guardsmen.sql",
	"0003_optimal_tana_nile.sql",
	"0004_lyrical_valkyrie.sql",
] as const;
const PRICING: ModelPricing = {
	currency: "USD",
	input_microunits_per_million_tokens: 2_000_000,
	output_microunits_per_million_tokens: 8_000_000,
	version: "integration-pricing-1",
};

const enabled =
	process.env.SENKO_RUN_POSTGRES_INTEGRATION === "1" &&
	process.env.SENKO_TEST_RAILWAY_SERVICE_ID === TEST_RAILWAY_SERVICE_ID;

function testConnectionString(): string {
	const raw = process.env.DATABASE_PUBLIC_URL;
	if (!raw) throw new Error("DATABASE_PUBLIC_URL is required for the Railway PostgreSQL integration test.");
	const url = new URL(raw);
	url.searchParams.set("sslmode", "require");
	url.searchParams.set("uselibpqcompat", "true");
	return url.toString();
}

function scopedConnectionString(connectionString: string, schemaName: string): string {
	const url = new URL(connectionString);
	url.searchParams.set("options", `-c search_path=${schemaName}`);
	return url.toString();
}

function quotedIdentifier(value: string): string {
	if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("Unsafe PostgreSQL test schema identifier.");
	return `"${value}"`;
}

async function applyMigrations(database: Client, schemaName: string): Promise<void> {
	const schema = quotedIdentifier(schemaName);
	const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");
	await database.query(`create schema ${schema}`);
	await database.query(`set search_path to ${schema}`);
	for (const filename of MIGRATIONS) {
		const migration = await readFile(join(migrationDirectory, filename), "utf8");
		const isolatedMigration = migration.replaceAll('"public".', `${schema}.`);
		for (const statement of isolatedMigration.split("--> statement-breakpoint")) {
			const sql = statement.trim();
			if (sql) await database.query(sql);
		}
	}
}

async function cleanupInterruptedPublicRun(database: Client): Promise<void> {
	await database.query("begin");
	try {
		const accountSelector = "select id from public.accounts where name = $1";
		await database.query(`delete from public.admin_audit_events where account_id in (${accountSelector})`, [
			INTERRUPTED_TEST_ACCOUNT_NAME,
		]);
		await database.query(`delete from public.api_key_scopes where account_id in (${accountSelector})`, [
			INTERRUPTED_TEST_ACCOUNT_NAME,
		]);
		await database.query(`delete from public.api_keys where account_id in (${accountSelector})`, [
			INTERRUPTED_TEST_ACCOUNT_NAME,
		]);
		await database.query("delete from public.accounts where name = $1", [INTERRUPTED_TEST_ACCOUNT_NAME]);
		await database.query("commit");
	} catch (error) {
		await database.query("rollback").catch(() => undefined);
		throw error;
	}
}

function requestId(): string {
	return `req_${randomUUID().replaceAll("-", "")}`;
}

function publicId(): string {
	return `test_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function keyHash(): string {
	return randomUUID().replaceAll("-", "").repeat(2);
}

describe.skipIf(!enabled)("Railway PostgreSQL API-key rotation", () => {
	it("serializes rotation with reservation and preserves the per-key ceiling", async () => {
		const baseConnectionString = testConnectionString();
		const schemaName = `senko_rotation_${randomUUID().replaceAll("-", "")}`;
		const accountId = randomUUID();
		const sourceKeyId = randomUUID();
		const database = new Client({ connectionString: baseConnectionString });
		let blocker: Client | undefined;
		let blockerTransactionOpen = false;
		let schemaCreated = false;

		try {
			await database.connect();
			await cleanupInterruptedPublicRun(database);
			await applyMigrations(database, schemaName);
			schemaCreated = true;
			const connectionString = scopedConnectionString(baseConnectionString, schemaName);
			blocker = new Client({ connectionString });
			await database.query("insert into accounts (id, name, plan_key) values ($1, $2, 'beta')", [
				accountId,
				INTERRUPTED_TEST_ACCOUNT_NAME,
			]);
			await database.query(
				`insert into api_keys
					(id, account_id, name, public_id, key_prefix, key_hash, hash_version, rotation_group_id)
				 values ($1, $2, 'Source key', $3, 'sk-senko-v1-test', $4, 1, $1)`,
				[sourceKeyId, accountId, publicId(), keyHash()],
			);
			await database.query(
				"insert into api_key_scopes (api_key_id, account_id, scope) values ($1, $2, 'inference:responses')",
				[sourceKeyId, accountId],
			);
			await database.query(
				`insert into account_usage_limits
					(account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
					 max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits)
				 values ($1, 'account-policy-1', 'USD', 100000, 100000, 10000, 100000, 1000000)`,
				[accountId],
			);
			await database.query(
				`insert into api_key_usage_limits
					(api_key_id, account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
					 max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits)
				 values ($1, $2, 'key-policy-1', 'USD', 1000, 1000, 100, 1000, 10000)`,
				[sourceKeyId, accountId],
			);

			await blocker.connect();
			await blocker.query("begin");
			blockerTransactionOpen = true;
			await blocker.query("select account_id from account_usage_limits where account_id = $1 for update", [accountId]);

			const env = {
				SENKO_API_KEY_HASH_SECRET_V1: HASH_SECRET,
				SENKO_DATABASE_URL: connectionString,
			} satisfies CloudflareBindings;
			const identity = createPostgresIdentityService();
			const usage = createPostgresUsageService();
			let rotationSettled = false;
			let reservationSettled = false;
			const rotationPromise = identity
				.rotateApiKey(env, { accountId, keyId: sourceKeyId, requestId: requestId() })
				.finally(() => {
					rotationSettled = true;
				});
			const sourceReservationPromise = usage
				.reserve(env, {
					accountId,
					apiKeyId: sourceKeyId,
					estimatedInputTokens: 100,
					pricing: PRICING,
					providerAttempt: 0,
					providerRoute: "integration-primary",
					protocol: "openai-responses",
					requestId: requestId(),
					requestedModel: "fast",
					reservationExpiresAt: new Date(Date.now() + 60_000),
					reservedOutputTokens: 200,
					resolvedModel: "provider/integration-model",
				})
				.finally(() => {
					reservationSettled = true;
				});

			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(rotationSettled).toBe(false);
			expect(reservationSettled).toBe(false);
			await blocker.query("commit");
			blockerTransactionOpen = false;

			const [rotation, sourceReservation] = await Promise.all([rotationPromise, sourceReservationPromise]);
			expect(rotation).toMatchObject({ ok: true, value: { replacesApiKeyId: sourceKeyId } });
			expect(sourceReservation).toEqual({ dimension: "max_request_cost", ok: false, reason: "limit_exceeded" });
			if (!rotation.ok) throw new Error("API-key rotation unexpectedly failed.");

			const copied = await database.query(
				`select policy_version, currency, minute_input_tokens, minute_output_tokens,
					max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits
				 from api_key_usage_limits where api_key_id = $1 and account_id = $2`,
				[rotation.value.id, accountId],
			);
			expect(copied.rows).toEqual([
				expect.objectContaining({
					currency: "USD",
					daily_cost_microunits: "1000",
					max_request_cost_microunits: "100",
					minute_input_tokens: "1000",
					minute_output_tokens: "1000",
					monthly_cost_microunits: "10000",
					policy_version: "key-policy-1",
				}),
			]);

			await expect(
				usage.reserve(env, {
					accountId,
					apiKeyId: rotation.value.id,
					estimatedInputTokens: 100,
					pricing: PRICING,
					providerAttempt: 0,
					providerRoute: "integration-primary",
					protocol: "openai-responses",
					requestId: requestId(),
					requestedModel: "fast",
					reservationExpiresAt: new Date(Date.now() + 60_000),
					reservedOutputTokens: 200,
					resolvedModel: "provider/integration-model",
				}),
			).resolves.toEqual({ dimension: "max_request_cost", ok: false, reason: "limit_exceeded" });

			await database.query("set search_path to public");
			await database.query(`drop schema ${quotedIdentifier(schemaName)} cascade`);
			schemaCreated = false;
			await expect(database.query("select to_regnamespace($1) as schema", [schemaName])).resolves.toMatchObject({
				rows: [{ schema: null }],
			});
			await expect(
				database.query("select count(*)::text as count from public.accounts where name = $1", [
					INTERRUPTED_TEST_ACCOUNT_NAME,
				]),
			).resolves.toMatchObject({ rows: [{ count: "0" }] });
		} finally {
			if (blockerTransactionOpen) await blocker?.query("rollback").catch(() => undefined);
			await blocker?.end().catch(() => undefined);
			if (schemaCreated) {
				await database.query("set search_path to public").catch(() => undefined);
				await database.query(`drop schema ${quotedIdentifier(schemaName)} cascade`).catch(() => undefined);
			}
			await database.end().catch(() => undefined);
		}
	}, 20_000);
});
