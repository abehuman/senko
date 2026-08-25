import { sql } from "drizzle-orm";
import {
	bigint,
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
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const AUDIT_ACTOR_TYPES = ["system", "user", "api_key"] as const;
export const USAGE_PROTOCOLS = ["openai-completions", "openai-responses"] as const;
export const USAGE_BUCKET_TYPES = ["minute_tokens", "day_cost", "month_cost"] as const;
export const USAGE_LEDGER_PHASES = ["reservation", "terminal", "reconciliation"] as const;
export const USAGE_LEDGER_EVENT_TYPES = [
	"reserved",
	"settled",
	"released",
	"conservative_settled",
	"reconciled",
] as const;
export const USAGE_SOURCES = ["none", "provider", "reservation", "reconciliation"] as const;
export const REQUEST_TRACE_ENDPOINTS = ["models", "chat_completions", "responses"] as const;
export const REQUEST_TRACE_FAILURE_CATEGORIES = [
	"admission",
	"authentication",
	"cancelled",
	"configuration",
	"internal",
	"invalid_request",
	"provider_protocol",
	"provider_capacity",
	"provider_rejected",
	"provider_transport",
	"quota",
	"timeout",
	"usage",
] as const;

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

export const accountUsageLimits = pgTable(
	"account_usage_limits",
	{
		accountId: uuid("account_id")
			.primaryKey()
			.references(() => accounts.id, { onDelete: "restrict" }),
		policyVersion: varchar("policy_version", { length: 64 }).notNull(),
		currency: char("currency", { length: 3 }).notNull(),
		minuteInputTokens: bigint("minute_input_tokens", { mode: "number" }).notNull(),
		minuteOutputTokens: bigint("minute_output_tokens", { mode: "number" }).notNull(),
		maxRequestCostMicrounits: bigint("max_request_cost_microunits", { mode: "number" }).notNull(),
		dailyCostMicrounits: bigint("daily_cost_microunits", { mode: "number" }).notNull(),
		monthlyCostMicrounits: bigint("monthly_cost_microunits", { mode: "number" }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		check("account_usage_limits_policy_version_check", sql`length(btrim(${table.policyVersion})) > 0`),
		check("account_usage_limits_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
		check("account_usage_limits_minute_input_check", sql`${table.minuteInputTokens} > 0`),
		check("account_usage_limits_minute_output_check", sql`${table.minuteOutputTokens} > 0`),
		check("account_usage_limits_max_request_cost_check", sql`${table.maxRequestCostMicrounits} > 0`),
		check("account_usage_limits_daily_cost_check", sql`${table.dailyCostMicrounits} > 0`),
		check("account_usage_limits_monthly_cost_check", sql`${table.monthlyCostMicrounits} > 0`),
		check(
			"account_usage_limits_cost_order_check",
			sql`${table.maxRequestCostMicrounits} <= ${table.dailyCostMicrounits} and ${table.dailyCostMicrounits} <= ${table.monthlyCostMicrounits}`,
		),
	],
);

export const apiKeyUsageLimits = pgTable(
	"api_key_usage_limits",
	{
		apiKeyId: uuid("api_key_id").primaryKey(),
		accountId: uuid("account_id").notNull(),
		policyVersion: varchar("policy_version", { length: 64 }).notNull(),
		currency: char("currency", { length: 3 }).notNull(),
		minuteInputTokens: bigint("minute_input_tokens", { mode: "number" }).notNull(),
		minuteOutputTokens: bigint("minute_output_tokens", { mode: "number" }).notNull(),
		maxRequestCostMicrounits: bigint("max_request_cost_microunits", { mode: "number" }).notNull(),
		dailyCostMicrounits: bigint("daily_cost_microunits", { mode: "number" }).notNull(),
		monthlyCostMicrounits: bigint("monthly_cost_microunits", { mode: "number" }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		unique("api_key_usage_limits_key_account_unique").on(table.apiKeyId, table.accountId),
		foreignKey({
			columns: [table.apiKeyId, table.accountId],
			foreignColumns: [apiKeys.id, apiKeys.accountId],
			name: "api_key_usage_limits_key_account_fk",
		}).onDelete("restrict"),
		check("api_key_usage_limits_policy_version_check", sql`length(btrim(${table.policyVersion})) > 0`),
		check("api_key_usage_limits_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
		check("api_key_usage_limits_minute_input_check", sql`${table.minuteInputTokens} > 0`),
		check("api_key_usage_limits_minute_output_check", sql`${table.minuteOutputTokens} > 0`),
		check("api_key_usage_limits_max_request_cost_check", sql`${table.maxRequestCostMicrounits} > 0`),
		check("api_key_usage_limits_daily_cost_check", sql`${table.dailyCostMicrounits} > 0`),
		check("api_key_usage_limits_monthly_cost_check", sql`${table.monthlyCostMicrounits} > 0`),
		check(
			"api_key_usage_limits_cost_order_check",
			sql`${table.maxRequestCostMicrounits} <= ${table.dailyCostMicrounits} and ${table.dailyCostMicrounits} <= ${table.monthlyCostMicrounits}`,
		),
		index("api_key_usage_limits_account_idx").on(table.accountId),
	],
);

export const requestTraces = pgTable(
	"request_traces",
	{
		requestId: varchar("request_id", { length: 64 }).primaryKey(),
		accountId: uuid("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "restrict" }),
		apiKeyId: uuid("api_key_id").notNull(),
		endpoint: varchar("endpoint", { enum: REQUEST_TRACE_ENDPOINTS, length: 32 }).notNull(),
		method: varchar("method", { length: 8 }).notNull(),
		httpStatus: integer("http_status").notNull(),
		failureCategory: varchar("failure_category", { enum: REQUEST_TRACE_FAILURE_CATEGORIES, length: 32 }),
		startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
		completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.apiKeyId, table.accountId],
			foreignColumns: [apiKeys.id, apiKeys.accountId],
			name: "request_traces_key_account_fk",
		}).onDelete("restrict"),
		check("request_traces_request_id_check", sql`${table.requestId} ~ '^req_[0-9a-f]{32}$'`),
		check("request_traces_endpoint_check", sql`${table.endpoint} in ('models', 'chat_completions', 'responses')`),
		check("request_traces_method_check", sql`${table.method} in ('GET', 'POST')`),
		check("request_traces_http_status_check", sql`${table.httpStatus} between 100 and 599`),
		check(
			"request_traces_failure_category_check",
			sql`${table.failureCategory} is null or ${table.failureCategory} in ('admission', 'authentication', 'cancelled', 'configuration', 'internal', 'invalid_request', 'provider_protocol', 'provider_capacity', 'provider_rejected', 'provider_transport', 'quota', 'timeout', 'usage')`,
		),
		check("request_traces_time_check", sql`${table.completedAt} >= ${table.startedAt}`),
		index("request_traces_account_started_idx").on(table.accountId, table.startedAt),
		index("request_traces_key_started_idx").on(table.apiKeyId, table.startedAt),
		index("request_traces_completed_idx").on(table.completedAt),
	],
);

export const usageAttempts = pgTable(
	"usage_attempts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		requestId: varchar("request_id", { length: 64 }).notNull(),
		providerAttempt: integer("provider_attempt").default(0).notNull(),
		accountId: uuid("account_id").notNull(),
		apiKeyId: uuid("api_key_id").notNull(),
		protocol: varchar("protocol", { enum: USAGE_PROTOCOLS, length: 32 }).notNull(),
		requestedModel: varchar("requested_model", { length: 160 }).notNull(),
		resolvedModel: varchar("resolved_model", { length: 160 }).notNull(),
		providerRoute: varchar("provider_route", { length: 128 }).notNull(),
		pricingVersion: varchar("pricing_version", { length: 64 }).notNull(),
		policyVersion: varchar("policy_version", { length: 64 }).notNull(),
		apiKeyPolicyVersion: varchar("api_key_policy_version", { length: 64 }),
		currency: char("currency", { length: 3 }).notNull(),
		inputPriceMicrounitsPerMillionTokens: bigint("input_price_microunits_per_million_tokens", {
			mode: "number",
		}).notNull(),
		outputPriceMicrounitsPerMillionTokens: bigint("output_price_microunits_per_million_tokens", {
			mode: "number",
		}).notNull(),
		estimatorVersion: varchar("estimator_version", { length: 64 }).notNull(),
		estimatedInputTokens: bigint("estimated_input_tokens", { mode: "number" }).notNull(),
		reservedOutputTokens: bigint("reserved_output_tokens", { mode: "number" }).notNull(),
		reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "number" }).notNull(),
		minuteWindowStart: timestamp("minute_window_start", { mode: "date", withTimezone: true }).notNull(),
		dayWindowStart: timestamp("day_window_start", { mode: "date", withTimezone: true }).notNull(),
		monthWindowStart: timestamp("month_window_start", { mode: "date", withTimezone: true }).notNull(),
		reservationExpiresAt: timestamp("reservation_expires_at", { mode: "date", withTimezone: true }).notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		unique("usage_attempts_id_account_id_unique").on(table.id, table.accountId),
		unique("usage_attempts_request_provider_attempt_unique").on(table.requestId, table.providerAttempt),
		foreignKey({
			columns: [table.apiKeyId, table.accountId],
			foreignColumns: [apiKeys.id, apiKeys.accountId],
			name: "usage_attempts_key_account_fk",
		}).onDelete("restrict"),
		check("usage_attempts_request_id_check", sql`${table.requestId} ~ '^req_[0-9a-f]{32}$'`),
		check("usage_attempts_provider_attempt_check", sql`${table.providerAttempt} >= 0`),
		check("usage_attempts_protocol_check", sql`${table.protocol} in ('openai-completions', 'openai-responses')`),
		check("usage_attempts_requested_model_check", sql`length(btrim(${table.requestedModel})) > 0`),
		check("usage_attempts_resolved_model_check", sql`length(btrim(${table.resolvedModel})) > 0`),
		check("usage_attempts_provider_route_check", sql`length(btrim(${table.providerRoute})) > 0`),
		check("usage_attempts_pricing_version_check", sql`length(btrim(${table.pricingVersion})) > 0`),
		check("usage_attempts_policy_version_check", sql`length(btrim(${table.policyVersion})) > 0`),
		check(
			"usage_attempts_api_key_policy_version_check",
			sql`${table.apiKeyPolicyVersion} is null or length(btrim(${table.apiKeyPolicyVersion})) > 0`,
		),
		check("usage_attempts_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
		check("usage_attempts_estimator_version_check", sql`length(btrim(${table.estimatorVersion})) > 0`),
		check(
			"usage_attempts_price_check",
			sql`${table.inputPriceMicrounitsPerMillionTokens} >= 0 and ${table.outputPriceMicrounitsPerMillionTokens} >= 0`,
		),
		check("usage_attempts_estimated_input_check", sql`${table.estimatedInputTokens} >= 0`),
		check("usage_attempts_reserved_output_check", sql`${table.reservedOutputTokens} > 0`),
		check("usage_attempts_reserved_cost_check", sql`${table.reservedCostMicrounits} >= 0`),
		check("usage_attempts_reservation_expiry_check", sql`${table.reservationExpiresAt} > ${table.createdAt}`),
		index("usage_attempts_account_created_idx").on(table.accountId, table.createdAt),
		index("usage_attempts_key_created_idx").on(table.apiKeyId, table.createdAt),
	],
);

export const usagePendingReservations = pgTable(
	"usage_pending_reservations",
	{
		attemptId: uuid("attempt_id").primaryKey(),
		accountId: uuid("account_id").notNull(),
		expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
		createdAt: createdAt(),
	},
	(table) => [
		foreignKey({
			columns: [table.attemptId, table.accountId],
			foreignColumns: [usageAttempts.id, usageAttempts.accountId],
			name: "usage_pending_reservations_attempt_account_fk",
		}).onDelete("restrict"),
		index("usage_pending_reservations_expiry_idx").on(table.expiresAt, table.attemptId),
	],
);

export const usageLedgerEntries = pgTable(
	"usage_ledger_entries",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		attemptId: uuid("attempt_id").notNull(),
		accountId: uuid("account_id").notNull(),
		phase: varchar("phase", { enum: USAGE_LEDGER_PHASES, length: 24 }).notNull(),
		eventType: varchar("event_type", { enum: USAGE_LEDGER_EVENT_TYPES, length: 32 }).notNull(),
		reservedInputTokens: bigint("reserved_input_tokens", { mode: "number" }).default(0).notNull(),
		reservedOutputTokens: bigint("reserved_output_tokens", { mode: "number" }).default(0).notNull(),
		reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "number" }).default(0).notNull(),
		releasedInputTokens: bigint("released_input_tokens", { mode: "number" }).default(0).notNull(),
		releasedOutputTokens: bigint("released_output_tokens", { mode: "number" }).default(0).notNull(),
		releasedCostMicrounits: bigint("released_cost_microunits", { mode: "number" }).default(0).notNull(),
		settledInputTokens: bigint("settled_input_tokens", { mode: "number" }).default(0).notNull(),
		settledOutputTokens: bigint("settled_output_tokens", { mode: "number" }).default(0).notNull(),
		settledCostMicrounits: bigint("settled_cost_microunits", { mode: "number" }).default(0).notNull(),
		usageSource: varchar("usage_source", { enum: USAGE_SOURCES, length: 24 }).notNull(),
		terminalReason: varchar("terminal_reason", { length: 64 }),
		createdAt: createdAt(),
	},
	(table) => [
		unique("usage_ledger_entries_attempt_phase_unique").on(table.attemptId, table.phase),
		foreignKey({
			columns: [table.attemptId, table.accountId],
			foreignColumns: [usageAttempts.id, usageAttempts.accountId],
			name: "usage_ledger_entries_attempt_account_fk",
		}).onDelete("restrict"),
		check("usage_ledger_entries_phase_check", sql`${table.phase} in ('reservation', 'terminal', 'reconciliation')`),
		check(
			"usage_ledger_entries_event_type_check",
			sql`${table.eventType} in ('reserved', 'settled', 'released', 'conservative_settled', 'reconciled')`,
		),
		check(
			"usage_ledger_entries_usage_source_check",
			sql`${table.usageSource} in ('none', 'provider', 'reservation', 'reconciliation')`,
		),
		check(
			"usage_ledger_entries_amounts_check",
			sql`${table.reservedInputTokens} >= 0 and ${table.reservedOutputTokens} >= 0 and ${table.reservedCostMicrounits} >= 0 and ${table.releasedInputTokens} >= 0 and ${table.releasedOutputTokens} >= 0 and ${table.releasedCostMicrounits} >= 0 and ${table.settledInputTokens} >= 0 and ${table.settledOutputTokens} >= 0 and ${table.settledCostMicrounits} >= 0`,
		),
		check(
			"usage_ledger_entries_phase_event_check",
			sql`(${table.phase} = 'reservation' and ${table.eventType} = 'reserved' and ${table.usageSource} = 'none' and ${table.terminalReason} is null and ${table.reservedOutputTokens} > 0 and ${table.releasedInputTokens} = 0 and ${table.releasedOutputTokens} = 0 and ${table.releasedCostMicrounits} = 0 and ${table.settledInputTokens} = 0 and ${table.settledOutputTokens} = 0 and ${table.settledCostMicrounits} = 0) or (${table.phase} = 'terminal' and ${table.eventType} in ('settled', 'released', 'conservative_settled') and ${table.usageSource} in ('provider', 'reservation', 'none') and ${table.terminalReason} is not null and ${table.reservedInputTokens} = 0 and ${table.reservedOutputTokens} = 0 and ${table.reservedCostMicrounits} = 0) or (${table.phase} = 'reconciliation' and ${table.eventType} = 'reconciled' and ${table.usageSource} = 'reconciliation' and ${table.terminalReason} is not null and ${table.reservedInputTokens} = 0 and ${table.reservedOutputTokens} = 0 and ${table.reservedCostMicrounits} = 0)`,
		),
		index("usage_ledger_entries_account_created_idx").on(table.accountId, table.createdAt),
		index("usage_ledger_entries_attempt_created_idx").on(table.attemptId, table.createdAt),
	],
);

export const accountUsageBuckets = pgTable(
	"account_usage_buckets",
	{
		accountId: uuid("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "restrict" }),
		bucketType: varchar("bucket_type", { enum: USAGE_BUCKET_TYPES, length: 24 }).notNull(),
		windowStart: timestamp("window_start", { mode: "date", withTimezone: true }).notNull(),
		reservedInputTokens: bigint("reserved_input_tokens", { mode: "number" }).default(0).notNull(),
		reservedOutputTokens: bigint("reserved_output_tokens", { mode: "number" }).default(0).notNull(),
		reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "number" }).default(0).notNull(),
		settledInputTokens: bigint("settled_input_tokens", { mode: "number" }).default(0).notNull(),
		settledOutputTokens: bigint("settled_output_tokens", { mode: "number" }).default(0).notNull(),
		settledCostMicrounits: bigint("settled_cost_microunits", { mode: "number" }).default(0).notNull(),
		updatedAt: updatedAt(),
	},
	(table) => [
		primaryKey({ columns: [table.accountId, table.bucketType, table.windowStart], name: "account_usage_buckets_pk" }),
		check("account_usage_buckets_type_check", sql`${table.bucketType} in ('minute_tokens', 'day_cost', 'month_cost')`),
		check(
			"account_usage_buckets_amounts_check",
			sql`${table.reservedInputTokens} >= 0 and ${table.reservedOutputTokens} >= 0 and ${table.reservedCostMicrounits} >= 0 and ${table.settledInputTokens} >= 0 and ${table.settledOutputTokens} >= 0 and ${table.settledCostMicrounits} >= 0`,
		),
		check(
			"account_usage_buckets_dimension_check",
			sql`(${table.bucketType} = 'minute_tokens' and ${table.reservedCostMicrounits} = 0 and ${table.settledCostMicrounits} = 0) or (${table.bucketType} in ('day_cost', 'month_cost') and ${table.reservedInputTokens} = 0 and ${table.reservedOutputTokens} = 0 and ${table.settledInputTokens} = 0 and ${table.settledOutputTokens} = 0)`,
		),
		index("account_usage_buckets_account_window_idx").on(table.accountId, table.windowStart),
	],
);

export const apiKeyUsageBuckets = pgTable(
	"api_key_usage_buckets",
	{
		apiKeyId: uuid("api_key_id").notNull(),
		accountId: uuid("account_id").notNull(),
		bucketType: varchar("bucket_type", { enum: USAGE_BUCKET_TYPES, length: 24 }).notNull(),
		windowStart: timestamp("window_start", { mode: "date", withTimezone: true }).notNull(),
		reservedInputTokens: bigint("reserved_input_tokens", { mode: "number" }).default(0).notNull(),
		reservedOutputTokens: bigint("reserved_output_tokens", { mode: "number" }).default(0).notNull(),
		reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "number" }).default(0).notNull(),
		settledInputTokens: bigint("settled_input_tokens", { mode: "number" }).default(0).notNull(),
		settledOutputTokens: bigint("settled_output_tokens", { mode: "number" }).default(0).notNull(),
		settledCostMicrounits: bigint("settled_cost_microunits", { mode: "number" }).default(0).notNull(),
		updatedAt: updatedAt(),
	},
	(table) => [
		primaryKey({
			columns: [table.apiKeyId, table.bucketType, table.windowStart],
			name: "api_key_usage_buckets_pk",
		}),
		foreignKey({
			columns: [table.apiKeyId, table.accountId],
			foreignColumns: [apiKeyUsageLimits.apiKeyId, apiKeyUsageLimits.accountId],
			name: "api_key_usage_buckets_key_account_fk",
		}).onDelete("restrict"),
		check("api_key_usage_buckets_type_check", sql`${table.bucketType} in ('minute_tokens', 'day_cost', 'month_cost')`),
		check(
			"api_key_usage_buckets_amounts_check",
			sql`${table.reservedInputTokens} >= 0 and ${table.reservedOutputTokens} >= 0 and ${table.reservedCostMicrounits} >= 0 and ${table.settledInputTokens} >= 0 and ${table.settledOutputTokens} >= 0 and ${table.settledCostMicrounits} >= 0`,
		),
		check(
			"api_key_usage_buckets_dimension_check",
			sql`(${table.bucketType} = 'minute_tokens' and ${table.reservedCostMicrounits} = 0 and ${table.settledCostMicrounits} = 0) or (${table.bucketType} in ('day_cost', 'month_cost') and ${table.reservedInputTokens} = 0 and ${table.reservedOutputTokens} = 0 and ${table.settledInputTokens} = 0 and ${table.settledOutputTokens} = 0)`,
		),
		index("api_key_usage_buckets_account_key_window_idx").on(table.accountId, table.apiKeyId, table.windowStart),
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

export const usageTables = {
	accountUsageBuckets,
	accountUsageLimits,
	apiKeyUsageBuckets,
	apiKeyUsageLimits,
	requestTraces,
	usageAttempts,
	usageLedgerEntries,
	usagePendingReservations,
} as const;
