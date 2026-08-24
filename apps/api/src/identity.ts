import { equalHexDigest, generateApiKey, hashApiKey, parseApiKey } from "./api-key";
import { bearerToken } from "./auth";
import { type DatabaseClient, type DatabaseClientFactory, getDatabaseConfig, withDatabaseClient } from "./database";
import type { ApiKeyScope } from "./db/schema";
import type { CloudflareBindings } from "./types";

const DUMMY_KEY_HASH = "0".repeat(64);
const KEY_GENERATION_ATTEMPTS = 3;
const LAST_USED_UPDATE_INTERVAL_MS = 15 * 60_000;
const LAST_USED_CACHE_MAX_KEYS = 1_000;

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
}

export interface ApiKeyRecord {
	accountId: string;
	createdAt: string;
	expiresAt: string | null;
	id: string;
	keyPrefix: string;
	name: string;
	publicId: string;
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

export interface IssueApiKeyInput {
	accountId: string;
	expiresAt: Date | null;
	name: string;
	requestId: string;
	scopes: ApiKeyScope[];
	teamId: string | null;
}

export interface RevokeApiKeyInput {
	accountId: string;
	keyId: string;
	requestId: string;
}

export interface IdentityService {
	authenticate(env: CloudflareBindings, authorization: string | undefined): Promise<IdentityResult<DatabaseIdentity>>;
	createAccount(env: CloudflareBindings, input: CreateAccountInput): Promise<IdentityResult<AccountRecord>>;
	issueApiKey(env: CloudflareBindings, input: IssueApiKeyInput): Promise<IdentityResult<IssuedApiKey>>;
	revokeApiKey(env: CloudflareBindings, input: RevokeApiKeyInput): Promise<IdentityResult<ApiKeyRecord>>;
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
}

interface ApiKeyRow {
	account_id: string;
	created_at: Date | string;
	expires_at: Date | string | null;
	id: string;
	key_prefix: string;
	name: string;
	public_id: string;
	status: string;
	team_id: string | null;
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
	};
}

function apiKeyRecord(row: ApiKeyRow, scopes: ApiKeyScope[]): ApiKeyRecord {
	return {
		accountId: row.account_id,
		createdAt: iso(row.created_at),
		expiresAt: optionalIso(row.expires_at),
		id: row.id,
		keyPrefix: row.key_prefix,
		name: row.name,
		publicId: row.public_id,
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
						 returning id, name, status, plan_key, created_at`,
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
							 returning id, account_id, team_id, name, public_id, key_prefix, status, expires_at, created_at`,
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

		async revokeApiKey(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const existing = await client.query<ApiKeyRow>(
						`select id, account_id, team_id, name, public_id, key_prefix, status, expires_at, created_at
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
							 returning id, account_id, team_id, name, public_id, key_prefix, status, expires_at, created_at`,
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
