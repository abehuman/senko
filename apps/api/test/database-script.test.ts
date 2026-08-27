import { describe, expect, it } from "vitest";

// @ts-expect-error The operational JavaScript module intentionally has no declaration file.
const databaseScript = await import("../scripts/database.mjs");
const {
	EXPECTED_MIGRATION_COUNT,
	EXPECTED_MIGRATION_HISTORY,
	EXPECTED_SCHEMA_COLUMNS,
	EXPECTED_TABLES,
	migrationHistoryErrors,
	schemaColumnErrors,
	validateDatabaseTarget,
	waitForDatabase,
} = databaseScript;

const targetEnvironment = {
	DATABASE_PUBLIC_URL: "postgresql://user:password@example.invalid/database",
	RAILWAY_ENVIRONMENT_ID: "environment-id",
	RAILWAY_PROJECT_ID: "project-id",
	RAILWAY_SERVICE_ID: "service-id",
	RAILWAY_SERVICE_NAME: "Senko Test Postgres",
	SENKO_EXPECTED_RAILWAY_ENVIRONMENT_ID: "environment-id",
	SENKO_EXPECTED_RAILWAY_PROJECT_ID: "project-id",
	SENKO_EXPECTED_RAILWAY_SERVICE_ID: "service-id",
};

describe("database operation target guard", () => {
	it("accepts a fully matched explicit Railway target", () => {
		expect(validateDatabaseTarget(targetEnvironment)).toMatchObject({
			environmentId: "environment-id",
			projectId: "project-id",
			serviceId: "service-id",
			serviceName: "Senko Test Postgres",
		});
	});

	it("rejects a service that differs from the expected target", () => {
		expect(() =>
			validateDatabaseTarget({
				...targetEnvironment,
				RAILWAY_SERVICE_ID: "production-service-id",
			}),
		).toThrow("service does not match the explicitly expected target");
	});

	it("rejects operations without an explicit expected target", () => {
		expect(() =>
			validateDatabaseTarget({
				...targetEnvironment,
				SENKO_EXPECTED_RAILWAY_SERVICE_ID: "",
			}),
		).toThrow("SENKO_EXPECTED_RAILWAY_SERVICE_ID is required");
	});

	it("rejects operations without a public database connection", () => {
		expect(() =>
			validateDatabaseTarget({
				...targetEnvironment,
				DATABASE_PUBLIC_URL: "",
			}),
		).toThrow("DATABASE_PUBLIC_URL is not available from the target service");
	});

	it("verifies the complete initial public-table contract", () => {
		expect(EXPECTED_TABLES).toEqual([
			"account_memberships",
			"account_usage_buckets",
			"account_usage_limits",
			"accounts",
			"admin_audit_events",
			"api_key_scopes",
			"api_key_usage_buckets",
			"api_key_usage_limits",
			"api_keys",
			"request_traces",
			"team_memberships",
			"teams",
			"usage_attempts",
			"usage_ledger_entries",
			"usage_pending_reservations",
			"users",
		]);
	});

	it("requires the complete ordered migration history and SQL hashes", () => {
		expect(EXPECTED_MIGRATION_COUNT).toBe(6);
		expect(migrationHistoryErrors(EXPECTED_MIGRATION_HISTORY)).toEqual([]);
		expect(migrationHistoryErrors(EXPECTED_MIGRATION_HISTORY.slice(0, -1))).toContainEqual(
			expect.stringContaining("Expected 6 Drizzle migration records"),
		);
		expect(
			migrationHistoryErrors([
				{ ...EXPECTED_MIGRATION_HISTORY[0], hash: "tampered" },
				...EXPECTED_MIGRATION_HISTORY.slice(1),
			]),
		).toContainEqual(expect.stringContaining("does not match the repository journal and SQL hash"));
	});

	it("detects missing, extra, nullable, and type-drifted columns from the latest snapshot", () => {
		expect(schemaColumnErrors(EXPECTED_SCHEMA_COLUMNS)).toEqual([]);
		expect(
			EXPECTED_SCHEMA_COLUMNS.some(
				(column: { columnName: string; tableName: string }) =>
					column.tableName === "usage_ledger_entries" && column.columnName === "over_limit_after_settlement",
			),
		).toBe(true);
		const withoutLatestColumn = EXPECTED_SCHEMA_COLUMNS.filter(
			(column: { columnName: string; tableName: string }) =>
				!(column.tableName === "usage_ledger_entries" && column.columnName === "over_limit_after_settlement"),
		);
		expect(schemaColumnErrors(withoutLatestColumn)).toContainEqual(
			expect.stringContaining("Missing or changed columns"),
		);
		const changedType = EXPECTED_SCHEMA_COLUMNS.map(
			(column: { columnName: string; notNull: boolean; tableName: string; type: string }) =>
				column.tableName === "accounts" && column.columnName === "name" ? { ...column, type: "text" } : column,
		);
		expect(schemaColumnErrors(changedType)).toEqual([
			expect.stringContaining("Missing or changed columns"),
			expect.stringContaining("Unexpected or changed columns"),
		]);
	});

	it("bounds Railway serverless wake-up retries before any database operation", async () => {
		const attempts: string[] = [];
		const pool = {
			async query(sql: string) {
				attempts.push(sql);
				if (attempts.length < 3) throw new Error("the database system is starting up");
				return { rows: [{ "?column?": 1 }] };
			},
		};
		await expect(
			waitForDatabase(pool, { attempts: 3, delayMs: 0, sleep: async () => undefined }),
		).resolves.toBeUndefined();
		expect(attempts).toEqual(["select 1", "select 1", "select 1"]);

		await expect(
			waitForDatabase(
				{
					async query() {
						throw new Error("still unavailable");
					},
				},
				{ attempts: 2, delayMs: 0, sleep: async () => undefined },
			),
		).rejects.toThrow("still unavailable");
	});
});
