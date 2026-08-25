import { equalHexDigest, generateApiKey, hashApiKey, parseApiKey } from "./api-key";
import { bearerToken } from "./auth";
import { type DatabaseClient, type DatabaseClientFactory, getDatabaseConfig, withDatabaseClient } from "./database";
import type { ApiKeyScope } from "./db/schema";
import type { CloudflareBindings } from "./types";

const DUMMY_KEY_HASH = "0".repeat(64);
const KEY_GENERATION_ATTEMPTS = 3;
const LAST_USED_UPDATE_INTERVAL_MS = 15 * 60_000;
const LAST_USED_CACHE_MAX_KEYS = 1_000;
const AUDIT_ACTIONS = new Set([
	"account.created",
	"account.reactivated",
	"account.suspended",
	"api_key.issued",
	"api_key.revoked",
	"api_key.rotated",
	"api_key_usage_limits.configured",
	"team.archived",
	"team.created",
	"team.reactivated",
	"usage_limits.configured",
]);
const AUDIT_ACTOR_TYPES = new Set(["api_key", "system", "user"]);
const AUDIT_TARGET_TYPES = new Set(["account", "account_usage_limits", "api_key", "api_key_usage_limits", "team"]);
const AUDIT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_REQUEST_ID_PATTERN = /^req_[a-f0-9]{32}$/;

type IdentityFailureReason = "configuration_error" | "conflict" | "not_found" | "unavailable";

export type IdentityResult<T> = { ok: true; value: T } | { message?: string; ok: false; reason: IdentityFailureReason };

export interface DatabaseIdentity {
	accountId: string;
	keyId: string;
	publicId: string;
	scopes: ApiKeyScope[];
}

export interface AccountRecord {
	createdAt: string;
	id: string;
	name: string;
	planKey: string;
	status: string;
	suspendedAt: string | null;
}

export interface ListAccountsInput {
	limit: number;
	startingAfter: string | null;
}

export interface AccountPage {
	data: AccountRecord[];
	hasMore: boolean;
}

export interface TeamRecord {
	accountId: string;
	createdAt: string;
	id: string;
	name: string;
	status: string;
}

export interface ApiKeyRecord {
	accountId: string;
	createdAt: string;
	expiresAt: string | null;
	id: string;
	keyPrefix: string;
	lastUsedAt: string | null;
	name: string;
	publicId: string;
	replacesApiKeyId: string | null;
	revokedAt: string | null;
	rotationGroupId: string;
	scopes: ApiKeyScope[];
	status: string;
	teamId: string | null;
}

export interface IssuedApiKey extends ApiKeyRecord {
	key: string;
}

export interface CreateAccountInput {
	name: string;
	planKey: string;
	requestId: string;
}

export interface CreateTeamInput {
	accountId: string;
	name: string;
	requestId: string;
}

export interface SetAccountStatusInput {
	accountId: string;
	requestId: string;
	status: "active" | "suspended";
}

export interface ListTeamsInput {
	accountId: string;
	limit: number;
	startingAfter: string | null;
}

export interface TeamPage {
	data: TeamRecord[];
	hasMore: boolean;
}

export interface AuditEventRecord {
	accountId: string;
	action: string;
	actorType: string;
	createdAt: string;
	id: string;
	requestId: string | null;
	targetId: string | null;
	targetType: string;
}

export interface ListAuditEventsInput {
	accountId: string;
	limit: number;
	startingAfter: string | null;
}

export interface AuditEventPage {
	data: AuditEventRecord[];
	hasMore: boolean;
}

export interface SetTeamStatusInput {
	accountId: string;
	requestId: string;
	status: "active" | "archived";
	teamId: string;
}

export interface IssueApiKeyInput {
	accountId: string;
	expiresAt: Date | null;
	name: string;
	requestId: string;
	scopes: ApiKeyScope[];
	teamId: string | null;
}

export interface ListApiKeysInput {
	accountId: string;
	limit: number;
	startingAfter: string | null;
}

export interface ApiKeyPage {
	data: ApiKeyRecord[];
	hasMore: boolean;
}

export interface RotateApiKeyInput {
	accountId: string;
	expiresAt?: Date | null;
	keyId: string;
	name?: string;
	requestId: string;
}

export interface RevokeApiKeyInput {
	accountId: string;
	keyId: string;
	requestId: string;
}

export interface IdentityService {
	authenticate(env: CloudflareBindings, authorization: string | undefined): Promise<IdentityResult<DatabaseIdentity>>;
	createAccount(env: CloudflareBindings, input: CreateAccountInput): Promise<IdentityResult<AccountRecord>>;
	createTeam(env: CloudflareBindings, input: CreateTeamInput): Promise<IdentityResult<TeamRecord>>;
	issueApiKey(env: CloudflareBindings, input: IssueApiKeyInput): Promise<IdentityResult<IssuedApiKey>>;
	listAccounts(env: CloudflareBindings, input: ListAccountsInput): Promise<IdentityResult<AccountPage>>;
	listAuditEvents(env: CloudflareBindings, input: ListAuditEventsInput): Promise<IdentityResult<AuditEventPage>>;
	listApiKeys(env: CloudflareBindings, input: ListApiKeysInput): Promise<IdentityResult<ApiKeyPage>>;
	listTeams(env: CloudflareBindings, input: ListTeamsInput): Promise<IdentityResult<TeamPage>>;
	revokeApiKey(env: CloudflareBindings, input: RevokeApiKeyInput): Promise<IdentityResult<ApiKeyRecord>>;
	rotateApiKey(env: CloudflareBindings, input: RotateApiKeyInput): Promise<IdentityResult<IssuedApiKey>>;
	setAccountStatus(env: CloudflareBindings, input: SetAccountStatusInput): Promise<IdentityResult<AccountRecord>>;
	setTeamStatus(env: CloudflareBindings, input: SetTeamStatusInput): Promise<IdentityResult<TeamRecord>>;
	touchLastUsed(env: CloudflareBindings, keyId: string): Promise<IdentityResult<undefined>>;
}

interface AuthenticationRow {
	account_id: string;
	account_status: string;
	expires_at: Date | string | null;
	hash_version: number;
	key_hash: string;
	key_id: string;
	key_status: string;
	public_id: string;
	scopes: string[] | null;
	team_status: string | null;
}

interface AccountRow {
	created_at: Date | string;
	id: string;
	name: string;
	plan_key: string;
	status: string;
	suspended_at: Date | string | null;
}

interface TeamRow {
	account_id: string;
	created_at: Date | string;
	id: string;
	name: string;
	status: string;
}

interface AuditEventRow {
	account_id: string;
	action: string;
	actor_type: string;
	created_at: Date | string;
	id: string;
	request_id: string | null;
	target_id: string | null;
	target_type: string;
}

interface ApiKeyRow {
	account_id: string;
	created_at: Date | string;
	expires_at: Date | string | null;
	id: string;
	key_prefix: string;
	last_used_at?: Date | string | null;
	name: string;
	public_id: string;
	replaces_api_key_id?: string | null;
	revoked_at?: Date | string | null;
	rotation_group_id?: string;
	status: string;
	team_id: string | null;
}

interface ApiKeyListRow extends ApiKeyRow {
	scopes: ApiKeyScope[] | null;
}

interface RotationSourceRow extends ApiKeyRow {
	account_status: string;
	team_status: string | null;
}

interface ApiKeyUsageLimitRow {
	account_id: string;
	currency: string;
	daily_cost_microunits: number | string;
	max_request_cost_microunits: number | string;
	minute_input_tokens: number | string;
	minute_output_tokens: number | string;
	monthly_cost_microunits: number | string;
	policy_version: string;
}

interface StatusRow {
	status: string;
}

interface DatabaseError {
	code?: string;
}

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | null {
	return value === null ? null : iso(value);
}

function accountRecord(row: AccountRow): AccountRecord {
	return {
		createdAt: iso(row.created_at),
		id: row.id,
		name: row.name,
		planKey: row.plan_key,
		status: row.status,
		suspendedAt: optionalIso(row.suspended_at),
	};
}

function teamRecord(row: TeamRow): TeamRecord {
	return {
		accountId: row.account_id,
		createdAt: iso(row.created_at),
		id: row.id,
		name: row.name,
		status: row.status,
	};
}

function auditEventRecord(row: AuditEventRow): AuditEventRecord {
	if (
		!AUDIT_UUID_PATTERN.test(row.id) ||
		!AUDIT_UUID_PATTERN.test(row.account_id) ||
		!AUDIT_ACTIONS.has(row.action) ||
		!AUDIT_ACTOR_TYPES.has(row.actor_type) ||
		!AUDIT_TARGET_TYPES.has(row.target_type) ||
		(row.target_id !== null && !AUDIT_UUID_PATTERN.test(row.target_id)) ||
		(row.request_id !== null && !AUDIT_REQUEST_ID_PATTERN.test(row.request_id))
	) {
		throw new Error("Invalid administrative audit event.");
	}
	return {
		accountId: row.account_id,
		action: row.action,
		actorType: row.actor_type,
		createdAt: iso(row.created_at),
		id: row.id,
		requestId: row.request_id,
		targetId: row.target_id,
		targetType: row.target_type,
	};
}

function apiKeyRecord(row: ApiKeyRow, scopes: ApiKeyScope[]): ApiKeyRecord {
	return {
		accountId: row.account_id,
		createdAt: iso(row.created_at),
		expiresAt: optionalIso(row.expires_at),
		id: row.id,
		keyPrefix: row.key_prefix,
		lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
		name: row.name,
		publicId: row.public_id,
		replacesApiKeyId: row.replaces_api_key_id ?? null,
		revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
		rotationGroupId: row.rotation_group_id ?? row.id,
		scopes,
		status: row.status,
		teamId: row.team_id,
	};
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as DatabaseError).code === "23505";
}

async function rollback(client: DatabaseClient): Promise<void> {
	await client.query("rollback").catch(() => undefined);
}

function configuration<T>(message: string): IdentityResult<T> {
	return { message, ok: false, reason: "configuration_error" };
}

function unavailable<T>(): IdentityResult<T> {
	return { ok: false, reason: "unavailable" };
}

export function createPostgresIdentityService(clientFactory?: DatabaseClientFactory): IdentityService {
	const nextLastUsedUpdate = new Map<string, number>();
	const run = async <T>(
		env: CloudflareBindings,
		operation: (client: DatabaseClient, hashSecret: string) => Promise<IdentityResult<T>>,
	): Promise<IdentityResult<T>> => {
		const config = getDatabaseConfig(env);
		if (!config.ok) {
			return configuration(config.message);
		}
		try {
			return await withDatabaseClient(
				config.connectionString,
				(client) => operation(client, config.hashSecret),
				clientFactory,
			);
		} catch {
			return unavailable();
		}
	};

	return {
		async authenticate(env, authorization) {
			const config = getDatabaseConfig(env);
			if (!config.ok) {
				return configuration(config.message);
			}
			const rawKey = bearerToken(authorization);
			const parsed = rawKey ? parseApiKey(rawKey) : undefined;
			if (!parsed) {
				return { ok: false, reason: "not_found" };
			}
			return run(env, async (client, hashSecret) => {
				const [candidateHash, result] = await Promise.all([
					hashApiKey(parsed.rawKey, hashSecret),
					client.query<AuthenticationRow>(
						`select
							k.id as key_id,
							k.account_id,
							k.public_id,
							k.key_hash,
							k.hash_version,
							k.status as key_status,
							k.expires_at,
							a.status as account_status,
							t.status as team_status,
							coalesce(array_agg(s.scope) filter (where s.scope is not null), '{}') as scopes
						from api_keys k
						join accounts a on a.id = k.account_id
						left join teams t on t.id = k.team_id and t.account_id = k.account_id
						left join api_key_scopes s on s.api_key_id = k.id and s.account_id = k.account_id
						where k.public_id = $1
						group by k.id, a.status, t.status`,
						[parsed.publicId],
					),
				]);
				const row = result.rows[0];
				const hashMatches = equalHexDigest(candidateHash, row?.key_hash ?? DUMMY_KEY_HASH);
				const unexpired =
					row?.expires_at === null || (row?.expires_at !== undefined && new Date(row.expires_at) > new Date());
				if (
					!row ||
					!hashMatches ||
					row.hash_version !== 1 ||
					row.key_status !== "active" ||
					row.account_status !== "active" ||
					(row.team_status !== null && row.team_status !== "active") ||
					!unexpired
				) {
					return { ok: false, reason: "not_found" };
				}
				return {
					ok: true,
					value: {
						accountId: row.account_id,
						keyId: row.key_id,
						publicId: row.public_id,
						scopes: (row.scopes ?? []) as ApiKeyScope[],
					},
				};
			});
		},

		async createAccount(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const result = await client.query<AccountRow>(
						`insert into accounts (name, plan_key)
						 values ($1, $2)
						 returning id, name, status, plan_key, suspended_at, created_at`,
						[input.name, input.planKey],
					);
					const row = result.rows[0];
					if (!row) {
						await rollback(client);
						return unavailable();
					}
					await client.query(
						`insert into admin_audit_events
							(account_id, actor_type, action, target_type, target_id, request_id, metadata)
						 values ($1::uuid, 'system', 'account.created', 'account', $1::uuid::text, $2, $3::jsonb)`,
						[row.id, input.requestId, JSON.stringify({ plan_key: row.plan_key })],
					);
					await client.query("commit");
					return { ok: true, value: accountRecord(row) };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async createTeam(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const account = await client.query<StatusRow>("select status from accounts where id = $1 for share", [
						input.accountId,
					]);
					if (!account.rows[0]) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					if (account.rows[0].status !== "active") {
						await rollback(client);
						return { ok: false, reason: "conflict" };
					}
					const result = await client.query<TeamRow>(
						`insert into teams (account_id, name)
						 values ($1, $2)
						 returning id, account_id, name, status, created_at`,
						[input.accountId, input.name],
					);
					const row = result.rows[0];
					if (!row) {
						throw new Error("Team insert returned no row.");
					}
					await client.query(
						`insert into admin_audit_events
							(account_id, actor_type, action, target_type, target_id, request_id, metadata)
						 values ($1, 'system', 'team.created', 'team', $2, $3, '{}'::jsonb)`,
						[input.accountId, row.id, input.requestId],
					);
					await client.query("commit");
					return { ok: true, value: teamRecord(row) };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async listAccounts(env, input) {
			return run(env, async (client) => {
				if (input.startingAfter) {
					const cursor = await client.query<{ id: string }>("select id from accounts where id = $1", [
						input.startingAfter,
					]);
					if (!cursor.rows[0]) {
						return { ok: false, reason: "not_found" };
					}
				}
				const result = await client.query<AccountRow>(
					`select id, name, status, plan_key, suspended_at, created_at
					 from accounts
					 where ($1::uuid is null or (created_at, id) < (
						select created_at, id from accounts where id = $1
					 ))
					 order by created_at desc, id desc
					 limit $2`,
					[input.startingAfter, input.limit + 1],
				);
				const hasMore = result.rows.length > input.limit;
				return {
					ok: true,
					value: { data: result.rows.slice(0, input.limit).map(accountRecord), hasMore },
				};
			});
		},

		async listApiKeys(env, input) {
			return run(env, async (client) => {
				const account = await client.query<{ id: string }>("select id from accounts where id = $1", [input.accountId]);
				if (!account.rows[0]) {
					return { ok: false, reason: "not_found" };
				}
				if (input.startingAfter) {
					const cursor = await client.query<{ id: string }>(
						"select id from api_keys where id = $1 and account_id = $2",
						[input.startingAfter, input.accountId],
					);
					if (!cursor.rows[0]) {
						return { ok: false, reason: "not_found" };
					}
				}
				const result = await client.query<ApiKeyListRow>(
					`select
						k.id, k.account_id, k.team_id, k.name, k.public_id, k.key_prefix, k.status,
						k.rotation_group_id, k.replaces_api_key_id, k.expires_at, k.last_used_at, k.revoked_at, k.created_at,
						coalesce(s.scopes, '{}') as scopes
					 from api_keys k
					 left join lateral (
						select array_agg(scope order by scope) as scopes
						from api_key_scopes where api_key_id = k.id and account_id = k.account_id
					 ) s on true
					 where k.account_id = $1
						and ($2::uuid is null or (k.created_at, k.id) < (
							select created_at, id from api_keys where id = $2 and account_id = $1
						))
					 order by k.created_at desc, k.id desc
					 limit $3`,
					[input.accountId, input.startingAfter, input.limit + 1],
				);
				const hasMore = result.rows.length > input.limit;
				return {
					ok: true,
					value: {
						data: result.rows.slice(0, input.limit).map((row) => apiKeyRecord(row, row.scopes ?? [])),
						hasMore,
					},
				};
			});
		},

		async listAuditEvents(env, input) {
			return run(env, async (client) => {
				const account = await client.query<{ id: string }>("select id from accounts where id = $1", [input.accountId]);
				if (!account.rows[0]) {
					return { ok: false, reason: "not_found" };
				}
				if (input.startingAfter) {
					const cursor = await client.query<{ id: string }>(
						"select id from admin_audit_events where id = $1 and account_id = $2",
						[input.startingAfter, input.accountId],
					);
					if (!cursor.rows[0]) {
						return { ok: false, reason: "not_found" };
					}
				}
				const result = await client.query<AuditEventRow>(
					`select id, account_id, actor_type, action, target_type, target_id, request_id, created_at
					 from admin_audit_events
					 where account_id = $1
						and ($2::uuid is null or (created_at, id) < (
							select created_at, id from admin_audit_events where id = $2 and account_id = $1
						))
					 order by created_at desc, id desc
					 limit $3`,
					[input.accountId, input.startingAfter, input.limit + 1],
				);
				const hasMore = result.rows.length > input.limit;
				return {
					ok: true,
					value: { data: result.rows.slice(0, input.limit).map(auditEventRecord), hasMore },
				};
			});
		},

		async listTeams(env, input) {
			return run(env, async (client) => {
				const account = await client.query<{ id: string }>("select id from accounts where id = $1", [input.accountId]);
				if (!account.rows[0]) {
					return { ok: false, reason: "not_found" };
				}
				if (input.startingAfter) {
					const cursor = await client.query<{ id: string }>("select id from teams where id = $1 and account_id = $2", [
						input.startingAfter,
						input.accountId,
					]);
					if (!cursor.rows[0]) {
						return { ok: false, reason: "not_found" };
					}
				}
				const result = await client.query<TeamRow>(
					`select id, account_id, name, status, created_at
					 from teams
					 where account_id = $1
						and ($2::uuid is null or (created_at, id) < (
							select created_at, id from teams where id = $2 and account_id = $1
						))
					 order by created_at desc, id desc
					 limit $3`,
					[input.accountId, input.startingAfter, input.limit + 1],
				);
				const hasMore = result.rows.length > input.limit;
				return {
					ok: true,
					value: { data: result.rows.slice(0, input.limit).map(teamRecord), hasMore },
				};
			});
		},

		async issueApiKey(env, input) {
			return run(env, async (client, hashSecret) => {
				for (let attempt = 0; attempt < KEY_GENERATION_ATTEMPTS; attempt += 1) {
					const generated = await generateApiKey(hashSecret);
					await client.query("begin");
					try {
						const account = await client.query<StatusRow>("select status from accounts where id = $1 for share", [
							input.accountId,
						]);
						if (!account.rows[0]) {
							await rollback(client);
							return { ok: false, reason: "not_found" };
						}
						if (account.rows[0].status !== "active") {
							await rollback(client);
							return { ok: false, reason: "conflict" };
						}
						if (input.teamId) {
							const team = await client.query<StatusRow>(
								"select status from teams where id = $1 and account_id = $2 for share",
								[input.teamId, input.accountId],
							);
							if (!team.rows[0]) {
								await rollback(client);
								return { ok: false, reason: "not_found" };
							}
							if (team.rows[0].status !== "active") {
								await rollback(client);
								return { ok: false, reason: "conflict" };
							}
						}

						const inserted = await client.query<ApiKeyRow>(
							`insert into api_keys
								(account_id, team_id, name, public_id, key_prefix, key_hash, hash_version, expires_at)
							 values ($1, $2, $3, $4, $5, $6, $7, $8)
							 returning id, account_id, team_id, name, public_id, key_prefix, status, rotation_group_id,
								replaces_api_key_id, expires_at, last_used_at, revoked_at, created_at`,
							[
								input.accountId,
								input.teamId,
								input.name,
								generated.publicId,
								generated.keyPrefix,
								generated.hash,
								generated.hashVersion,
								input.expiresAt,
							],
						);
						const row = inserted.rows[0];
						if (!row) {
							throw new Error("API key insert returned no row.");
						}
						await client.query(
							`insert into api_key_scopes (api_key_id, account_id, scope)
							 select $1, $2, scope from unnest($3::varchar[]) as requested_scope(scope)`,
							[row.id, input.accountId, input.scopes],
						);
						await client.query(
							`insert into admin_audit_events
								(account_id, actor_type, action, target_type, target_id, request_id, metadata)
							 values ($1, 'system', 'api_key.issued', 'api_key', $2, $3, $4::jsonb)`,
							[
								input.accountId,
								row.id,
								input.requestId,
								JSON.stringify({ has_expiry: input.expiresAt !== null, scopes: input.scopes, team_id: input.teamId }),
							],
						);
						await client.query("commit");
						return { ok: true, value: { ...apiKeyRecord(row, input.scopes), key: generated.rawKey } };
					} catch (error) {
						await rollback(client);
						if (isUniqueViolation(error) && attempt + 1 < KEY_GENERATION_ATTEMPTS) {
							continue;
						}
						throw error;
					}
				}
				return unavailable();
			});
		},

		async rotateApiKey(env, input) {
			return run(env, async (client, hashSecret) => {
				for (let attempt = 0; attempt < KEY_GENERATION_ATTEMPTS; attempt += 1) {
					const generated = await generateApiKey(hashSecret);
					await client.query("begin");
					try {
						const account = await client.query<StatusRow>("select status from accounts where id = $1 for share", [
							input.accountId,
						]);
						if (!account.rows[0]) {
							await rollback(client);
							return { ok: false, reason: "not_found" };
						}
						if (account.rows[0].status !== "active") {
							await rollback(client);
							return { ok: false, reason: "conflict" };
						}
						// Shared usage-policy lock order: account_usage_limits -> api_keys -> api_key_usage_limits.
						// configureApiKeyLimits and reserve begin with the same account policy lock, so rotation
						// copies one committed key policy without introducing a lock-order cycle.
						await client.query("select account_id from account_usage_limits where account_id = $1 for update", [
							input.accountId,
						]);
						const source = await client.query<RotationSourceRow>(
							`select
								k.id, k.account_id, k.team_id, k.name, k.public_id, k.key_prefix, k.status,
								k.rotation_group_id, k.replaces_api_key_id, k.expires_at, k.last_used_at, k.revoked_at,
								k.created_at, a.status as account_status, t.status as team_status
							 from api_keys k
							 join accounts a on a.id = k.account_id
							 left join teams t on t.id = k.team_id and t.account_id = k.account_id
							 where k.id = $1 and k.account_id = $2
							 for update of k`,
							[input.keyId, input.accountId],
						);
						const sourceRow = source.rows[0];
						if (!sourceRow) {
							await rollback(client);
							return { ok: false, reason: "not_found" };
						}
						let teamStatus: string | null = null;
						if (sourceRow.team_id) {
							const team = await client.query<StatusRow>(
								"select status from teams where id = $1 and account_id = $2 for share",
								[sourceRow.team_id, input.accountId],
							);
							if (!team.rows[0]) {
								throw new Error("Rotated API key team is missing.");
							}
							teamStatus = team.rows[0].status;
						}
						const sourceUnexpired = sourceRow.expires_at === null || new Date(sourceRow.expires_at) > new Date();
						if (sourceRow.status !== "active" || (teamStatus !== null && teamStatus !== "active") || !sourceUnexpired) {
							await rollback(client);
							return { ok: false, reason: "conflict" };
						}
						const sourceUsageLimits = await client.query<ApiKeyUsageLimitRow>(
							`select account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
								max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits
							 from api_key_usage_limits where api_key_id = $1 and account_id = $2 for update`,
							[input.keyId, input.accountId],
						);
						const scopes = await client.query<{ scope: ApiKeyScope }>(
							"select scope from api_key_scopes where api_key_id = $1 and account_id = $2 order by scope",
							[input.keyId, input.accountId],
						);
						const nextScopes = scopes.rows.map((scope) => scope.scope);
						if (nextScopes.length === 0) {
							throw new Error("Rotated API key has no scopes.");
						}
						const expiresAt = input.expiresAt === undefined ? sourceRow.expires_at : input.expiresAt;
						const inserted = await client.query<ApiKeyRow>(
							`insert into api_keys
								(account_id, team_id, name, public_id, key_prefix, key_hash, hash_version, rotation_group_id,
								 replaces_api_key_id, expires_at)
							 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
							 returning id, account_id, team_id, name, public_id, key_prefix, status, rotation_group_id,
								replaces_api_key_id, expires_at, last_used_at, revoked_at, created_at`,
							[
								input.accountId,
								sourceRow.team_id,
								input.name ?? sourceRow.name,
								generated.publicId,
								generated.keyPrefix,
								generated.hash,
								generated.hashVersion,
								sourceRow.rotation_group_id ?? sourceRow.id,
								sourceRow.id,
								expiresAt,
							],
						);
						const row = inserted.rows[0];
						if (!row) {
							throw new Error("API key rotation insert returned no row.");
						}
						await client.query(
							`insert into api_key_scopes (api_key_id, account_id, scope)
							 select $1, $2, scope from unnest($3::varchar[]) as requested_scope(scope)`,
							[row.id, input.accountId, nextScopes],
						);
						const sourceUsageLimit = sourceUsageLimits.rows[0];
						if (sourceUsageLimit) {
							await client.query(
								`insert into api_key_usage_limits
									(api_key_id, account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
									 max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits)
								 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
								[
									row.id,
									input.accountId,
									sourceUsageLimit.policy_version,
									sourceUsageLimit.currency,
									sourceUsageLimit.minute_input_tokens,
									sourceUsageLimit.minute_output_tokens,
									sourceUsageLimit.max_request_cost_microunits,
									sourceUsageLimit.daily_cost_microunits,
									sourceUsageLimit.monthly_cost_microunits,
								],
							);
						}
						await client.query(
							`insert into admin_audit_events
								(account_id, actor_type, action, target_type, target_id, request_id, metadata)
							 values ($1, 'system', 'api_key.rotated', 'api_key', $2, $3, $4::jsonb)`,
							[
								input.accountId,
								row.id,
								input.requestId,
								JSON.stringify({
									replaces_api_key_id: sourceRow.id,
									rotation_group_id: row.rotation_group_id,
									usage_limits_inherited: sourceUsageLimit !== undefined,
								}),
							],
						);
						await client.query("commit");
						return { ok: true, value: { ...apiKeyRecord(row, nextScopes), key: generated.rawKey } };
					} catch (error) {
						await rollback(client);
						if (isUniqueViolation(error) && attempt + 1 < KEY_GENERATION_ATTEMPTS) {
							continue;
						}
						throw error;
					}
				}
				return unavailable();
			});
		},

		async setAccountStatus(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const existing = await client.query<AccountRow>(
						`select id, name, status, plan_key, suspended_at, created_at
						 from accounts where id = $1 for update`,
						[input.accountId],
					);
					let row = existing.rows[0];
					if (!row) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					if (row.status === "closed") {
						await rollback(client);
						return { ok: false, reason: "conflict" };
					}
					const changed = row.status !== input.status;
					if (changed) {
						const updated = await client.query<AccountRow>(
							`update accounts set
								status = $2,
								suspended_at = case when $2 = 'suspended' then now() else null end,
								updated_at = now()
							 where id = $1 and status <> 'closed'
							 returning id, name, status, plan_key, suspended_at, created_at`,
							[input.accountId, input.status],
						);
						if (!updated.rows[0]) {
							throw new Error("Account status update returned no row.");
						}
						row = updated.rows[0];
						await client.query(
							`insert into admin_audit_events
								(account_id, actor_type, action, target_type, target_id, request_id, metadata)
							 values ($1::uuid, 'system', $2, 'account', $1::uuid::text, $3, '{}'::jsonb)`,
							[
								input.accountId,
								input.status === "suspended" ? "account.suspended" : "account.reactivated",
								input.requestId,
							],
						);
					}
					await client.query("commit");
					return { ok: true, value: accountRecord(row) };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async setTeamStatus(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const account = await client.query<StatusRow>("select status from accounts where id = $1 for share", [
						input.accountId,
					]);
					if (!account.rows[0]) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					if (input.status === "active" && account.rows[0].status !== "active") {
						await rollback(client);
						return { ok: false, reason: "conflict" };
					}
					const existing = await client.query<TeamRow>(
						`select id, account_id, name, status, created_at
						 from teams where id = $1 and account_id = $2 for update`,
						[input.teamId, input.accountId],
					);
					let row = existing.rows[0];
					if (!row) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					const changed = row.status !== input.status;
					if (changed) {
						const updated = await client.query<TeamRow>(
							`update teams set status = $3, updated_at = now()
							 where id = $1 and account_id = $2
							 returning id, account_id, name, status, created_at`,
							[input.teamId, input.accountId, input.status],
						);
						if (!updated.rows[0]) {
							throw new Error("Team status update returned no row.");
						}
						row = updated.rows[0];
						await client.query(
							`insert into admin_audit_events
								(account_id, actor_type, action, target_type, target_id, request_id, metadata)
							 values ($1, 'system', $2, 'team', $3, $4, '{}'::jsonb)`,
							[
								input.accountId,
								input.status === "archived" ? "team.archived" : "team.reactivated",
								input.teamId,
								input.requestId,
							],
						);
					}
					await client.query("commit");
					return { ok: true, value: teamRecord(row) };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async revokeApiKey(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const existing = await client.query<ApiKeyRow>(
						`select id, account_id, team_id, name, public_id, key_prefix, status, rotation_group_id,
							replaces_api_key_id, expires_at, last_used_at, revoked_at, created_at
						 from api_keys where id = $1 and account_id = $2 for update`,
						[input.keyId, input.accountId],
					);
					let row = existing.rows[0];
					if (!row) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					const changed = row.status !== "revoked";
					if (changed) {
						const updated = await client.query<ApiKeyRow>(
							`update api_keys
							 set status = 'revoked', revoked_at = now(), updated_at = now()
							 where id = $1 and account_id = $2
							 returning id, account_id, team_id, name, public_id, key_prefix, status, rotation_group_id,
								replaces_api_key_id, expires_at, last_used_at, revoked_at, created_at`,
							[input.keyId, input.accountId],
						);
						if (!updated.rows[0]) {
							throw new Error("API key revoke returned no row.");
						}
						row = updated.rows[0];
					}
					const scopes = await client.query<{ scope: ApiKeyScope }>(
						"select scope from api_key_scopes where api_key_id = $1 and account_id = $2 order by scope",
						[input.keyId, input.accountId],
					);
					if (changed) {
						await client.query(
							`insert into admin_audit_events
								(account_id, actor_type, action, target_type, target_id, request_id, metadata)
							 values ($1, 'system', 'api_key.revoked', 'api_key', $2, $3, '{}'::jsonb)`,
							[input.accountId, input.keyId, input.requestId],
						);
					}
					await client.query("commit");
					return {
						ok: true,
						value: apiKeyRecord(
							row,
							scopes.rows.map((scope) => scope.scope),
						),
					};
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async touchLastUsed(env, keyId) {
			if ((nextLastUsedUpdate.get(keyId) ?? 0) > Date.now()) {
				return { ok: true, value: undefined };
			}
			const result = await run(env, async (client) => {
				await client.query(
					`update api_keys
					 set last_used_at = now(), updated_at = now()
					 where id = $1 and (last_used_at is null or last_used_at < now() - interval '15 minutes')`,
					[keyId],
				);
				return { ok: true, value: undefined };
			});
			if (result.ok) {
				if (nextLastUsedUpdate.size >= LAST_USED_CACHE_MAX_KEYS && !nextLastUsedUpdate.has(keyId)) {
					nextLastUsedUpdate.clear();
				}
				nextLastUsedUpdate.set(keyId, Date.now() + LAST_USED_UPDATE_INTERVAL_MS);
			}
			return result;
		},
	};
}

export const postgresIdentityService = createPostgresIdentityService();
