import { describe, expect, it } from "vitest";
// @ts-expect-error The operational JavaScript module intentionally has no declaration file.
import { EXPECTED_TABLES, validateDatabaseTarget } from "../scripts/database.mjs";

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
			"accounts",
			"admin_audit_events",
			"api_key_scopes",
			"api_keys",
			"team_memberships",
			"teams",
			"users",
		]);
	});
});
