import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
	API_KEY_SCOPES,
	accountUsageBuckets,
	apiKeyScopes,
	apiKeys,
	apiKeyUsageBuckets,
	apiKeyUsageLimits,
	iamTables,
	requestTraces,
	teamMemberships,
	usageAttempts,
	usageLedgerEntries,
	usagePendingReservations,
	usageTables,
} from "../src/db/schema.js";

describe("IAM database schema", () => {
	it("uses the expected tenant-owned table boundary", () => {
		expect(Object.values(iamTables).map((table) => getTableName(table))).toEqual([
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

	it("stores only API key lookup and hash material", () => {
		const columns = getTableColumns(apiKeys);
		expect(Object.keys(columns)).toEqual([
			"id",
			"accountId",
			"teamId",
			"name",
			"publicId",
			"keyPrefix",
			"keyHash",
			"hashVersion",
			"status",
			"rotationGroupId",
			"replacesApiKeyId",
			"createdByUserId",
			"expiresAt",
			"lastUsedAt",
			"revokedAt",
			"createdAt",
			"updatedAt",
		]);
		expect("rawKey" in columns).toBe(false);
		expect("secret" in columns).toBe(false);
		expect(columns.keyHash.notNull).toBe(true);
		expect(columns.publicId.notNull).toBe(true);
	});

	it("prevents team and key records from crossing account boundaries", () => {
		expect(getTableConfig(teamMemberships).foreignKeys.map((key) => key.getName())).toEqual([
			"team_memberships_team_account_fk",
			"team_memberships_account_member_fk",
		]);
		expect(getTableConfig(apiKeys).foreignKeys.map((key) => key.getName())).toEqual(
			expect.arrayContaining([
				"api_keys_team_account_fk",
				"api_keys_creator_account_member_fk",
				"api_keys_replaces_same_account_fk",
			]),
		);
	});

	it("limits keys to the initial public API scopes", () => {
		expect(API_KEY_SCOPES).toEqual(["models:read", "inference:chat", "inference:responses"]);
		expect(getTableColumns(apiKeyScopes).scope.enumValues).toEqual(API_KEY_SCOPES);
	});
});

describe("usage accounting database schema", () => {
	it("separates immutable attempts and ledger events from mutable aggregate buckets", () => {
		expect(Object.values(usageTables).map((table) => getTableName(table))).toEqual([
			"account_usage_buckets",
			"account_usage_limits",
			"api_key_usage_buckets",
			"api_key_usage_limits",
			"request_traces",
			"usage_attempts",
			"usage_ledger_entries",
			"usage_pending_reservations",
		]);
		expect(getTableConfig(usageAttempts).foreignKeys.map((key) => key.getName())).toContain(
			"usage_attempts_key_account_fk",
		);
		expect(getTableConfig(usageLedgerEntries).foreignKeys.map((key) => key.getName())).toEqual([
			"usage_ledger_entries_attempt_account_fk",
		]);
		expect(getTableConfig(usagePendingReservations).foreignKeys.map((key) => key.getName())).toEqual([
			"usage_pending_reservations_attempt_account_fk",
		]);
		expect(getTableConfig(usagePendingReservations).indexes.map((index) => index.config.name)).toEqual([
			"usage_pending_reservations_expiry_idx",
		]);
	});

	it("stores only content-free bounded request envelopes", () => {
		const columns = getTableColumns(requestTraces);
		expect(Object.keys(columns)).toEqual([
			"requestId",
			"accountId",
			"apiKeyId",
			"endpoint",
			"method",
			"httpStatus",
			"failureCategory",
			"startedAt",
			"completedAt",
		]);
		for (const forbidden of ["prompt", "input", "output", "messages", "tools", "authorization", "keyHash"]) {
			expect(Object.keys(columns)).not.toContain(forbidden);
		}
		expect(getTableConfig(requestTraces).foreignKeys.map((key) => key.getName())).toEqual(
			expect.arrayContaining(["request_traces_key_account_fk"]),
		);
	});

	it("keeps bucket dimensions tenant-owned and disjoint", () => {
		const columns = getTableColumns(accountUsageBuckets);
		expect(Object.keys(columns)).toEqual([
			"accountId",
			"bucketType",
			"windowStart",
			"reservedInputTokens",
			"reservedOutputTokens",
			"reservedCostMicrounits",
			"settledInputTokens",
			"settledOutputTokens",
			"settledCostMicrounits",
			"updatedAt",
		]);
		expect(getTableConfig(accountUsageBuckets).checks.map((check) => check.name)).toEqual(
			expect.arrayContaining(["account_usage_buckets_amounts_check", "account_usage_buckets_dimension_check"]),
		);
		expect(getTableConfig(apiKeyUsageBuckets).foreignKeys.map((key) => key.getName())).toEqual([
			"api_key_usage_buckets_key_account_fk",
		]);
		expect(getTableConfig(apiKeyUsageLimits).foreignKeys.map((key) => key.getName())).toEqual([
			"api_key_usage_limits_key_account_fk",
		]);
		expect(getTableColumns(apiKeyUsageBuckets).accountId.notNull).toBe(true);
		expect(getTableColumns(apiKeyUsageLimits).accountId.notNull).toBe(true);
	});

	it("persists the terminal over-limit result for idempotent settlement retries", () => {
		const columns = getTableColumns(usageLedgerEntries);
		expect(columns.overLimitAfterSettlement.notNull).toBe(true);
		expect(columns.overLimitAfterSettlement.hasDefault).toBe(true);
	});
});
