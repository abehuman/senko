import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

export const EXPECTED_TABLES = [
	"account_memberships",
	"accounts",
	"admin_audit_events",
	"api_key_scopes",
	"api_keys",
	"team_memberships",
	"teams",
	"users",
];

const EXPECTED_FOREIGN_KEYS = [
	"account_memberships_account_id_accounts_id_fk",
	"account_memberships_user_id_users_id_fk",
	"admin_audit_events_account_id_accounts_id_fk",
	"admin_audit_events_actor_key_fk",
	"admin_audit_events_actor_user_fk",
	"api_key_scopes_key_account_fk",
	"api_keys_account_id_accounts_id_fk",
	"api_keys_creator_account_member_fk",
	"api_keys_replaces_same_account_fk",
	"api_keys_team_account_fk",
	"team_memberships_account_member_fk",
	"team_memberships_team_account_fk",
	"teams_account_id_accounts_id_fk",
];

const EXPECTED_CHECK_CONSTRAINTS = [
	"account_memberships_role_check",
	"account_memberships_status_check",
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
	"api_keys_expiry_check",
	"api_keys_hash_check",
	"api_keys_hash_version_check",
	"api_keys_last_used_check",
	"api_keys_name_check",
	"api_keys_prefix_check",
	"api_keys_public_id_check",
	"api_keys_revocation_check",
	"api_keys_status_check",
	"team_memberships_role_check",
	"team_memberships_status_check",
	"teams_name_check",
	"teams_status_check",
	"users_display_name_check",
	"users_status_check",
];

const EXPECTED_INDEXES = [
	"account_memberships_user_status_idx",
	"accounts_status_idx",
	"admin_audit_events_account_created_idx",
	"admin_audit_events_request_id_idx",
	"api_key_scopes_account_idx",
	"api_keys_account_status_idx",
	"api_keys_key_hash_unique",
	"api_keys_public_id_unique",
	"api_keys_rotation_group_idx",
	"api_keys_team_status_idx",
	"team_memberships_account_user_idx",
	"teams_account_status_idx",
	"users_status_idx",
];

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
	};
}

async function verifyDatabase(pool) {
	const state = await readDatabaseState(pool);
	const unexpectedTables = state.tables.filter((table) => !EXPECTED_TABLES.includes(table));
	const missingTables = missing(EXPECTED_TABLES, state.tables);

	const [foreignKeys, checkConstraints, indexes] = await Promise.all([
		pool.query(
			"select conname from pg_catalog.pg_constraint where contype = 'f' and connamespace = current_schema()::regnamespace order by conname",
		),
		pool.query(
			"select conname from pg_catalog.pg_constraint where contype = 'c' and connamespace = current_schema()::regnamespace order by conname",
		),
		pool.query("select indexname from pg_catalog.pg_indexes where schemaname = current_schema() order by indexname"),
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
	if (state.appliedMigrations < 1) errors.push("No Drizzle migration record exists.");
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
				migrationsFolder: fileURLToPath(new URL("../db/migrations", import.meta.url)),
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
