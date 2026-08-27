import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../db/migrations", import.meta.url));
const EXPECTED_MIGRATIONS = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

export const EXPECTED_MIGRATION_COUNT = EXPECTED_MIGRATIONS.length;
export const EXPECTED_MIGRATION_HISTORY = EXPECTED_MIGRATIONS.map((migration) => ({
	created_at: migration.folderMillis,
	hash: migration.hash,
}));

export const EXPECTED_TABLES = [
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
];

const EXPECTED_FOREIGN_KEYS = [
	"account_memberships_account_id_accounts_id_fk",
	"account_memberships_user_id_users_id_fk",
	"account_usage_buckets_account_id_accounts_id_fk",
	"account_usage_limits_account_id_accounts_id_fk",
	"admin_audit_events_account_id_accounts_id_fk",
	"admin_audit_events_actor_key_fk",
	"admin_audit_events_actor_user_fk",
	"api_key_scopes_key_account_fk",
	"api_key_usage_buckets_key_account_fk",
	"api_key_usage_limits_key_account_fk",
	"api_keys_account_id_accounts_id_fk",
	"api_keys_creator_account_member_fk",
	"api_keys_replaces_same_account_fk",
	"api_keys_team_account_fk",
	"request_traces_account_id_accounts_id_fk",
	"request_traces_key_account_fk",
	"team_memberships_account_member_fk",
	"team_memberships_team_account_fk",
	"teams_account_id_accounts_id_fk",
	"usage_attempts_key_account_fk",
	"usage_ledger_entries_attempt_account_fk",
	"usage_pending_reservations_attempt_account_fk",
];

const EXPECTED_CHECK_CONSTRAINTS = [
	"account_memberships_role_check",
	"account_memberships_status_check",
	"account_usage_buckets_amounts_check",
	"account_usage_buckets_dimension_check",
	"account_usage_buckets_type_check",
	"account_usage_limits_cost_order_check",
	"account_usage_limits_currency_check",
	"account_usage_limits_daily_cost_check",
	"account_usage_limits_max_request_cost_check",
	"account_usage_limits_minute_input_check",
	"account_usage_limits_minute_output_check",
	"account_usage_limits_monthly_cost_check",
	"account_usage_limits_policy_version_check",
	"accounts_name_check",
	"accounts_plan_key_check",
	"accounts_status_check",
	"accounts_suspension_check",
	"admin_audit_events_action_check",
	"admin_audit_events_actor_check",
	"admin_audit_events_actor_type_check",
	"admin_audit_events_metadata_object_check",
	"admin_audit_events_target_type_check",
	"api_key_scopes_scope_check",
	"api_key_usage_buckets_amounts_check",
	"api_key_usage_buckets_dimension_check",
	"api_key_usage_buckets_type_check",
	"api_key_usage_limits_cost_order_check",
	"api_key_usage_limits_currency_check",
	"api_key_usage_limits_daily_cost_check",
	"api_key_usage_limits_max_request_cost_check",
	"api_key_usage_limits_minute_input_check",
	"api_key_usage_limits_minute_output_check",
	"api_key_usage_limits_monthly_cost_check",
	"api_key_usage_limits_policy_version_check",
	"api_keys_expiry_check",
	"api_keys_hash_check",
	"api_keys_hash_version_check",
	"api_keys_last_used_check",
	"api_keys_name_check",
	"api_keys_prefix_check",
	"api_keys_public_id_check",
	"api_keys_revocation_check",
	"api_keys_status_check",
	"request_traces_endpoint_check",
	"request_traces_failure_category_check",
	"request_traces_http_status_check",
	"request_traces_method_check",
	"request_traces_request_id_check",
	"request_traces_time_check",
	"team_memberships_role_check",
	"team_memberships_status_check",
	"teams_name_check",
	"teams_status_check",
	"usage_attempts_currency_check",
	"usage_attempts_api_key_policy_version_check",
	"usage_attempts_estimated_input_check",
	"usage_attempts_estimator_version_check",
	"usage_attempts_policy_version_check",
	"usage_attempts_price_check",
	"usage_attempts_pricing_version_check",
	"usage_attempts_protocol_check",
	"usage_attempts_provider_attempt_check",
	"usage_attempts_provider_route_check",
	"usage_attempts_request_id_check",
	"usage_attempts_requested_model_check",
	"usage_attempts_reservation_expiry_check",
	"usage_attempts_reserved_cost_check",
	"usage_attempts_reserved_output_check",
	"usage_attempts_resolved_model_check",
	"usage_ledger_entries_amounts_check",
	"usage_ledger_entries_event_type_check",
	"usage_ledger_entries_phase_check",
	"usage_ledger_entries_phase_event_check",
	"usage_ledger_entries_usage_source_check",
	"users_display_name_check",
	"users_status_check",
];

const EXPECTED_INDEXES = [
	"account_memberships_user_status_idx",
	"account_usage_buckets_account_window_idx",
	"accounts_status_idx",
	"admin_audit_events_account_created_idx",
	"admin_audit_events_request_id_idx",
	"api_key_scopes_account_idx",
	"api_key_usage_buckets_account_key_window_idx",
	"api_key_usage_limits_account_idx",
	"api_keys_account_status_idx",
	"api_keys_key_hash_unique",
	"api_keys_public_id_unique",
	"api_keys_rotation_group_idx",
	"api_keys_team_status_idx",
	"request_traces_account_started_idx",
	"request_traces_completed_idx",
	"request_traces_key_started_idx",
	"team_memberships_account_user_idx",
	"teams_account_status_idx",
	"usage_attempts_account_created_idx",
	"usage_attempts_key_created_idx",
	"usage_ledger_entries_account_created_idx",
	"usage_ledger_entries_attempt_created_idx",
	"usage_pending_reservations_expiry_idx",
	"users_status_idx",
];

function normalizeSnapshotType(type) {
	const varchar = /^varchar\((\d+)\)$/.exec(type);
	if (varchar) return `character varying(${varchar[1]})`;
	const char = /^char\((\d+)\)$/.exec(type);
	if (char) return `character(${char[1]})`;
	return type;
}

function readExpectedSchemaColumns() {
	const snapshotIndex = String(EXPECTED_MIGRATION_COUNT - 1).padStart(4, "0");
	const snapshot = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/${snapshotIndex}_snapshot.json`, "utf8"));
	return Object.values(snapshot.tables)
		.filter((table) => EXPECTED_TABLES.includes(table.name))
		.flatMap((table) =>
			Object.values(table.columns).map((column) => ({
				columnName: column.name,
				notNull: column.notNull === true,
				tableName: table.name,
				type: normalizeSnapshotType(column.type),
			})),
		)
		.sort((left, right) =>
			`${left.tableName}.${left.columnName}`.localeCompare(`${right.tableName}.${right.columnName}`),
		);
}

export const EXPECTED_SCHEMA_COLUMNS = readExpectedSchemaColumns();

const TARGET_FIELDS = [
	["project", "RAILWAY_PROJECT_ID", "SENKO_EXPECTED_RAILWAY_PROJECT_ID"],
	["environment", "RAILWAY_ENVIRONMENT_ID", "SENKO_EXPECTED_RAILWAY_ENVIRONMENT_ID"],
	["service", "RAILWAY_SERVICE_ID", "SENKO_EXPECTED_RAILWAY_SERVICE_ID"],
];

export function validateDatabaseTarget(environment) {
	for (const [label, actualKey, expectedKey] of TARGET_FIELDS) {
		const actual = environment[actualKey]?.trim();
		const expected = environment[expectedKey]?.trim();
		if (!expected) {
			throw new Error(`Refusing database operation: ${expectedKey} is required.`);
		}
		if (!actual) {
			throw new Error(`Refusing database operation: Railway did not provide ${actualKey}.`);
		}
		if (actual !== expected) {
			throw new Error(`Refusing database operation: ${label} does not match the explicitly expected target.`);
		}
	}

	const connectionString = environment.DATABASE_PUBLIC_URL?.trim();
	if (!connectionString) {
		throw new Error("Refusing database operation: DATABASE_PUBLIC_URL is not available from the target service.");
	}

	return {
		connectionString,
		environmentId: environment.RAILWAY_ENVIRONMENT_ID,
		projectId: environment.RAILWAY_PROJECT_ID,
		serviceId: environment.RAILWAY_SERVICE_ID,
		serviceName: environment.RAILWAY_SERVICE_NAME ?? null,
	};
}

function missing(expected, actual) {
	const actualSet = new Set(actual);
	return expected.filter((name) => !actualSet.has(name));
}

function migrationIdentity(migration) {
	return `${Number(migration.created_at)}:${migration.hash}`;
}

export function migrationHistoryErrors(appliedMigrations) {
	const errors = [];
	if (appliedMigrations.length !== EXPECTED_MIGRATION_COUNT) {
		errors.push(
			`Expected ${EXPECTED_MIGRATION_COUNT} Drizzle migration records but found ${appliedMigrations.length}.`,
		);
	}
	for (let index = 0; index < Math.min(appliedMigrations.length, EXPECTED_MIGRATION_COUNT); index += 1) {
		const expected = EXPECTED_MIGRATIONS[index];
		const applied = appliedMigrations[index];
		if (migrationIdentity(applied) !== `${expected.folderMillis}:${expected.hash}`) {
			errors.push(`Drizzle migration record ${index + 1} does not match the repository journal and SQL hash.`);
		}
	}
	return errors;
}

function columnIdentity(column) {
	return `${column.tableName}.${column.columnName}:${column.type}:${column.notNull ? "not-null" : "nullable"}`;
}

export function schemaColumnErrors(actualColumns) {
	const expected = EXPECTED_SCHEMA_COLUMNS.map(columnIdentity);
	const actual = actualColumns.map(columnIdentity);
	const missingColumns = missing(expected, actual);
	const unexpectedColumns = missing(actual, expected);
	const errors = [];
	if (missingColumns.length > 0) errors.push(`Missing or changed columns: ${missingColumns.join(", ")}.`);
	if (unexpectedColumns.length > 0) errors.push(`Unexpected or changed columns: ${unexpectedColumns.join(", ")}.`);
	return errors;
}

export async function waitForDatabase(
	pool,
	{
		attempts = 8,
		delayMs = 2_000,
		sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	} = {},
) {
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			await pool.query("select 1");
			return;
		} catch (error) {
			lastError = error;
			if (attempt + 1 < attempts) await sleep(delayMs);
		}
	}
	throw lastError;
}

async function readDatabaseState(pool) {
	const [identity, tables, migrationTable] = await Promise.all([
		pool.query(
			"select current_database() as database_name, current_user as database_user, current_setting('server_version') as server_version, coalesce((select ssl from pg_catalog.pg_stat_ssl where pid = pg_backend_pid()), false) as tls_enabled",
		),
		pool.query("select tablename from pg_catalog.pg_tables where schemaname = current_schema() order by tablename"),
		pool.query("select to_regclass('drizzle.__drizzle_migrations')::text as migration_table"),
	]);

	let appliedMigrations = 0;
	if (migrationTable.rows[0]?.migration_table) {
		const migrationCount = await pool.query("select count(*)::integer as count from drizzle.__drizzle_migrations");
		appliedMigrations = migrationCount.rows[0]?.count ?? 0;
	}

	return {
		appliedMigrations,
		databaseName: identity.rows[0]?.database_name,
		databaseUser: identity.rows[0]?.database_user,
		serverVersion: identity.rows[0]?.server_version,
		tables: tables.rows.map((row) => row.tablename),
		tlsEnabled: identity.rows[0]?.tls_enabled === true,
		migrationTablePresent: Boolean(migrationTable.rows[0]?.migration_table),
	};
}

async function verifyDatabase(pool) {
	const state = await readDatabaseState(pool);
	const unexpectedTables = state.tables.filter((table) => !EXPECTED_TABLES.includes(table));
	const missingTables = missing(EXPECTED_TABLES, state.tables);

	const migrationHistoryPromise = state.migrationTablePresent
		? pool.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at, id")
		: Promise.resolve({ rows: [] });
	const [foreignKeys, checkConstraints, indexes, columns, migrationHistory] = await Promise.all([
		pool.query(
			"select conname from pg_catalog.pg_constraint where contype = 'f' and connamespace = current_schema()::regnamespace order by conname",
		),
		pool.query(
			"select conname from pg_catalog.pg_constraint where contype = 'c' and connamespace = current_schema()::regnamespace order by conname",
		),
		pool.query("select indexname from pg_catalog.pg_indexes where schemaname = current_schema() order by indexname"),
		pool.query(
			`select c.relname as table_name, a.attname as column_name,
				format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull as not_null
			 from pg_catalog.pg_attribute a
			 join pg_catalog.pg_class c on c.oid = a.attrelid
			 join pg_catalog.pg_namespace n on n.oid = c.relnamespace
			 where n.nspname = current_schema() and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
			 order by c.relname, a.attnum`,
		),
		migrationHistoryPromise,
	]);

	const missingForeignKeys = missing(
		EXPECTED_FOREIGN_KEYS,
		foreignKeys.rows.map((row) => row.conname),
	);
	const missingCheckConstraints = missing(
		EXPECTED_CHECK_CONSTRAINTS,
		checkConstraints.rows.map((row) => row.conname),
	);
	const missingIndexes = missing(
		EXPECTED_INDEXES,
		indexes.rows.map((row) => row.indexname),
	);

	const errors = [];
	if (!state.tlsEnabled) errors.push("The public PostgreSQL connection is not using TLS.");
	errors.push(...migrationHistoryErrors(migrationHistory.rows));
	errors.push(
		...schemaColumnErrors(
			columns.rows.map((column) => ({
				columnName: column.column_name,
				notNull: column.not_null === true,
				tableName: column.table_name,
				type: column.data_type,
			})),
		),
	);
	if (missingTables.length > 0) errors.push(`Missing tables: ${missingTables.join(", ")}.`);
	if (unexpectedTables.length > 0) errors.push(`Unexpected public tables: ${unexpectedTables.join(", ")}.`);
	if (missingForeignKeys.length > 0) errors.push(`Missing foreign keys: ${missingForeignKeys.join(", ")}.`);
	if (missingCheckConstraints.length > 0) {
		errors.push(`Missing check constraints: ${missingCheckConstraints.join(", ")}.`);
	}
	if (missingIndexes.length > 0) errors.push(`Missing indexes: ${missingIndexes.join(", ")}.`);
	if (errors.length > 0) throw new Error(`Database schema verification failed:\n- ${errors.join("\n- ")}`);

	return {
		...state,
		checkConstraintCount: checkConstraints.rows.length,
		foreignKeyCount: foreignKeys.rows.length,
		indexCount: indexes.rows.length,
	};
}

async function main() {
	const command = process.argv[2];
	if (!new Set(["inspect", "migrate", "verify"]).has(command)) {
		throw new Error("Usage: node scripts/database.mjs <inspect|migrate|verify>");
	}

	const target = validateDatabaseTarget(process.env);
	const pool = new Pool({
		application_name: `senko-db-${command}`,
		connectionString: target.connectionString,
		connectionTimeoutMillis: 15_000,
		idleTimeoutMillis: 5_000,
		max: 1,
	});

	try {
		// Railway serverless PostgreSQL can reject the first connection while waking.
		// Retry only this read-only preflight; migration statements are never retried here.
		await waitForDatabase(pool);
		const initialState = await readDatabaseState(pool);
		const targetSummary = {
			environmentId: target.environmentId,
			projectId: target.projectId,
			serviceId: target.serviceId,
			serviceName: target.serviceName,
		};

		if (command === "inspect") {
			console.log(JSON.stringify({ target: targetSummary, database: initialState }, null, 2));
			return;
		}

		if (command === "migrate") {
			const unexpectedTables = initialState.tables.filter((table) => !EXPECTED_TABLES.includes(table));
			if (unexpectedTables.length > 0) {
				throw new Error(
					`Refusing migration because public contains unexpected tables: ${unexpectedTables.join(", ")}.`,
				);
			}
			if (initialState.tables.length > 0 && initialState.appliedMigrations === 0) {
				throw new Error("Refusing migration because IAM tables exist without Drizzle migration history.");
			}

			await pool.query("set lock_timeout = '10s'");
			await pool.query("set statement_timeout = '60s'");
			const database = drizzle({ client: pool });
			await migrate(database, {
				migrationsFolder: MIGRATIONS_FOLDER,
			});
		}

		const verifiedState = await verifyDatabase(pool);
		console.log(JSON.stringify({ target: targetSummary, database: verifiedState, verified: true }, null, 2));
	} finally {
		await pool.end();
	}
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPoint === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
