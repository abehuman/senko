import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { API_KEY_SCOPES, apiKeyScopes, apiKeys, iamTables, teamMemberships } from "../src/db/schema.js";

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
