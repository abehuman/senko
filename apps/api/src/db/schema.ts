import { sql } from "drizzle-orm";
import {
	char,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const USER_STATUSES = ["active", "disabled", "deleted"] as const;
export const ACCOUNT_STATUSES = ["active", "suspended", "closed"] as const;
export const TEAM_STATUSES = ["active", "archived"] as const;
export const MEMBERSHIP_STATUSES = ["active", "disabled"] as const;
export const ACCOUNT_ROLES = ["owner", "admin", "billing", "member"] as const;
export const TEAM_ROLES = ["admin", "member"] as const;
export const API_KEY_STATUSES = ["active", "disabled", "revoked"] as const;
export const API_KEY_SCOPES = ["models:read", "inference:chat", "inference:responses"] as const;
export const AUDIT_ACTOR_TYPES = ["system", "user", "api_key"] as const;

const createdAt = () => timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull();

export const users = pgTable(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		status: varchar("status", { enum: USER_STATUSES, length: 16 }).default("active").notNull(),
		displayName: varchar("display_name", { length: 120 }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check("users_status_check", sql`${table.status} in ('active', 'disabled', 'deleted')`),
		check("users_display_name_check", sql`${table.displayName} is null or length(btrim(${table.displayName})) > 0`),
		index("users_status_idx").on(table.status),
	],
);

export const accounts = pgTable(
	"accounts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		name: varchar("name", { length: 160 }).notNull(),
		status: varchar("status", { enum: ACCOUNT_STATUSES, length: 16 }).default("active").notNull(),
		planKey: varchar("plan_key", { length: 64 }).default("beta").notNull(),
		suspendedAt: timestamp("suspended_at", { mode: "date", withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check("accounts_name_check", sql`length(btrim(${table.name})) > 0`),
		check("accounts_status_check", sql`${table.status} in ('active', 'suspended', 'closed')`),
		check("accounts_plan_key_check", sql`${table.planKey} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
		check(
			"accounts_suspension_check",
			sql`(${table.status} = 'suspended' and ${table.suspendedAt} is not null) or (${table.status} <> 'suspended' and ${table.suspendedAt} is null)`,
		),
		index("accounts_status_idx").on(table.status),
	],
);

export const teams = pgTable(
	"teams",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "restrict" }),
		name: varchar("name", { length: 160 }).notNull(),
		status: varchar("status", { enum: TEAM_STATUSES, length: 16 }).default("active").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check("teams_name_check", sql`length(btrim(${table.name})) > 0`),
		check("teams_status_check", sql`${table.status} in ('active', 'archived')`),
		unique("teams_id_account_id_unique").on(table.id, table.accountId),
		index("teams_account_status_idx").on(table.accountId, table.status),
	],
);

export const accountMemberships = pgTable(
	"account_memberships",
	{
		accountId: uuid("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "restrict" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		role: varchar("role", { enum: ACCOUNT_ROLES, length: 16 }).notNull(),
		status: varchar("status", { enum: MEMBERSHIP_STATUSES, length: 16 }).default("active").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		primaryKey({ columns: [table.accountId, table.userId], name: "account_memberships_pk" }),
		check("account_memberships_role_check", sql`${table.role} in ('owner', 'admin', 'billing', 'member')`),
		check("account_memberships_status_check", sql`${table.status} in ('active', 'disabled')`),
		index("account_memberships_user_status_idx").on(table.userId, table.status),
	],
);

export const teamMemberships = pgTable(
	"team_memberships",
	{
		teamId: uuid("team_id").notNull(),
		accountId: uuid("account_id").notNull(),
		userId: uuid("user_id").notNull(),
		role: varchar("role", { enum: TEAM_ROLES, length: 16 }).notNull(),
		status: varchar("status", { enum: MEMBERSHIP_STATUSES, length: 16 }).default("active").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		primaryKey({ columns: [table.teamId, table.userId], name: "team_memberships_pk" }),
		foreignKey({
			columns: [table.teamId, table.accountId],
			foreignColumns: [teams.id, teams.accountId],
			name: "team_memberships_team_account_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.accountId, table.userId],
			foreignColumns: [accountMemberships.accountId, accountMemberships.userId],
			name: "team_memberships_account_member_fk",
		}).onDelete("restrict"),
		check("team_memberships_role_check", sql`${table.role} in ('admin', 'member')`),
		check("team_memberships_status_check", sql`${table.status} in ('active', 'disabled')`),
		index("team_memberships_account_user_idx").on(table.accountId, table.userId),
	],
);

export const apiKeys = pgTable(
	"api_keys",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "restrict" }),
		teamId: uuid("team_id"),
		name: varchar("name", { length: 120 }).notNull(),
		publicId: varchar("public_id", { length: 32 }).notNull(),
		keyPrefix: varchar("key_prefix", { length: 24 }).notNull(),
		keyHash: char("key_hash", { length: 64 }).notNull(),
		hashVersion: integer("hash_version").default(1).notNull(),
		status: varchar("status", { enum: API_KEY_STATUSES, length: 16 }).default("active").notNull(),
		rotationGroupId: uuid("rotation_group_id").defaultRandom().notNull(),
		replacesApiKeyId: uuid("replaces_api_key_id"),
		createdByUserId: uuid("created_by_user_id"),
		expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
		lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
		revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		unique("api_keys_id_account_id_unique").on(table.id, table.accountId),
		uniqueIndex("api_keys_public_id_unique").on(table.publicId),
		uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
		foreignKey({
			columns: [table.teamId, table.accountId],
			foreignColumns: [teams.id, teams.accountId],
			name: "api_keys_team_account_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.accountId, table.createdByUserId],
			foreignColumns: [accountMemberships.accountId, accountMemberships.userId],
			name: "api_keys_creator_account_member_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.replacesApiKeyId, table.accountId],
			foreignColumns: [table.id, table.accountId],
			name: "api_keys_replaces_same_account_fk",
		}).onDelete("restrict"),
		check("api_keys_name_check", sql`length(btrim(${table.name})) > 0`),
		check("api_keys_public_id_check", sql`${table.publicId} ~ '^[A-Za-z0-9_-]{16,32}$'`),
		check("api_keys_prefix_check", sql`length(btrim(${table.keyPrefix})) > 0`),
		check("api_keys_hash_check", sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
		check("api_keys_hash_version_check", sql`${table.hashVersion} > 0`),
		check("api_keys_status_check", sql`${table.status} in ('active', 'disabled', 'revoked')`),
		check("api_keys_expiry_check", sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`),
		check("api_keys_last_used_check", sql`${table.lastUsedAt} is null or ${table.lastUsedAt} >= ${table.createdAt}`),
		check(
			"api_keys_revocation_check",
			sql`(${table.status} = 'revoked' and ${table.revokedAt} is not null) or (${table.status} <> 'revoked' and ${table.revokedAt} is null)`,
		),
		index("api_keys_account_status_idx").on(table.accountId, table.status),
		index("api_keys_team_status_idx").on(table.teamId, table.status),
		index("api_keys_rotation_group_idx").on(table.rotationGroupId),
	],
);

export const apiKeyScopes = pgTable(
	"api_key_scopes",
	{
		apiKeyId: uuid("api_key_id").notNull(),
		accountId: uuid("account_id").notNull(),
		scope: varchar("scope", { enum: API_KEY_SCOPES, length: 64 }).notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.apiKeyId, table.scope], name: "api_key_scopes_pk" }),
		foreignKey({
			columns: [table.apiKeyId, table.accountId],
			foreignColumns: [apiKeys.id, apiKeys.accountId],
			name: "api_key_scopes_key_account_fk",
		}).onDelete("cascade"),
		check(
			"api_key_scopes_scope_check",
			sql`${table.scope} in ('models:read', 'inference:chat', 'inference:responses')`,
		),
		index("api_key_scopes_account_idx").on(table.accountId),
	],
);

export const adminAuditEvents = pgTable(
	"admin_audit_events",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "restrict" }),
		actorType: varchar("actor_type", { enum: AUDIT_ACTOR_TYPES, length: 16 }).notNull(),
		actorUserId: uuid("actor_user_id"),
		actorApiKeyId: uuid("actor_api_key_id"),
		action: varchar("action", { length: 80 }).notNull(),
		targetType: varchar("target_type", { length: 64 }).notNull(),
		targetId: varchar("target_id", { length: 128 }),
		requestId: varchar("request_id", { length: 64 }),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			columns: [table.accountId, table.actorUserId],
			foreignColumns: [accountMemberships.accountId, accountMemberships.userId],
			name: "admin_audit_events_actor_user_fk",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.actorApiKeyId, table.accountId],
			foreignColumns: [apiKeys.id, apiKeys.accountId],
			name: "admin_audit_events_actor_key_fk",
		}).onDelete("restrict"),
		check("admin_audit_events_actor_type_check", sql`${table.actorType} in ('system', 'user', 'api_key')`),
		check(
			"admin_audit_events_actor_check",
			sql`(${table.actorType} = 'system' and ${table.actorUserId} is null and ${table.actorApiKeyId} is null) or (${table.actorType} = 'user' and ${table.actorUserId} is not null and ${table.actorApiKeyId} is null) or (${table.actorType} = 'api_key' and ${table.actorUserId} is null and ${table.actorApiKeyId} is not null)`,
		),
		check("admin_audit_events_action_check", sql`length(btrim(${table.action})) > 0`),
		check("admin_audit_events_target_type_check", sql`length(btrim(${table.targetType})) > 0`),
		check("admin_audit_events_metadata_object_check", sql`jsonb_typeof(${table.metadata}) = 'object'`),
		index("admin_audit_events_account_created_idx").on(table.accountId, table.createdAt),
		index("admin_audit_events_request_id_idx").on(table.requestId),
	],
);

export const iamTables = {
	accountMemberships,
	accounts,
	adminAuditEvents,
	apiKeyScopes,
	apiKeys,
	teamMemberships,
	teams,
	users,
} as const;
