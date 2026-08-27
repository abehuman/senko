import { checkAdmissionDependency } from "./admission";
import { getAuthenticationMode, getInferenceEnabled, getModelCatalog } from "./config";
import { getDatabaseConfig, withDatabaseClient } from "./database";
import { checkProviderPoolDependency } from "./provider-pool";
import { getProviderRouteCandidates } from "./provider-routing";
import type { CloudflareBindings } from "./types";

export type DependencyCheckStatus = "failed" | "not_checked" | "ok";

export interface DependencyHealthResult {
	checks: {
		admission: DependencyCheckStatus;
		configuration: DependencyCheckStatus;
		identity_storage: DependencyCheckStatus;
		provider_capacity: DependencyCheckStatus;
		usage_ledger: DependencyCheckStatus;
	};
	status: "ok" | "unhealthy";
}

export interface DependencyHealthService {
	check(env: CloudflareBindings): Promise<DependencyHealthResult>;
}

interface DatabaseDependencyResult {
	identityStorage: boolean;
	usageLedger: boolean;
}

export const IDENTITY_STORAGE_TABLES = [
	"account_memberships",
	"accounts",
	"admin_audit_events",
	"api_key_scopes",
	"api_keys",
	"team_memberships",
	"teams",
	"users",
] as const;

export const USAGE_LEDGER_TABLES = [
	"account_usage_buckets",
	"account_usage_limits",
	"api_key_usage_buckets",
	"api_key_usage_limits",
	"request_traces",
	"usage_attempts",
	"usage_ledger_entries",
	"usage_pending_reservations",
] as const;

export function databaseDependencyFromTables(tableNames: readonly string[]): DatabaseDependencyResult {
	const tables = new Set(tableNames);
	return {
		identityStorage: IDENTITY_STORAGE_TABLES.every((table) => tables.has(table)),
		usageLedger: USAGE_LEDGER_TABLES.every((table) => tables.has(table)),
	};
}

export interface DependencyProbes {
	admission(env: CloudflareBindings): Promise<boolean>;
	database(env: CloudflareBindings): Promise<DatabaseDependencyResult>;
	providerPool(env: CloudflareBindings, routeId: string): Promise<boolean>;
}

const defaultProbes: DependencyProbes = {
	admission: checkAdmissionDependency,
	async database(env) {
		const config = getDatabaseConfig(env);
		if (!config.ok) return { identityStorage: false, usageLedger: false };
		try {
			return await withDatabaseClient(config.connectionString, async (client) => {
				const requiredTables = [...IDENTITY_STORAGE_TABLES, ...USAGE_LEDGER_TABLES];
				const result = await client.query<{ tablename: string }>(
					`select tablename from pg_catalog.pg_tables
					 where schemaname = current_schema() and tablename = any($1::text[])
					 order by tablename`,
					[requiredTables],
				);
				return databaseDependencyFromTables(result.rows.map((row) => row.tablename));
			});
		} catch {
			return { identityStorage: false, usageLedger: false };
		}
	},
	providerPool: checkProviderPoolDependency,
};

function configurationRouteIds(env: CloudflareBindings): string[] | undefined {
	const authentication = getAuthenticationMode(env);
	const enabled = getInferenceEnabled(env);
	const catalog = getModelCatalog(env);
	if (
		!authentication.ok ||
		authentication.value !== "database" ||
		!enabled.ok ||
		!enabled.value ||
		!catalog.ok ||
		!env.SENKO_ADMISSION ||
		!env.SENKO_PROVIDER_POOLS
	) {
		return undefined;
	}
	const database = getDatabaseConfig(env);
	if (!database.ok || catalog.value.models.some((model) => !model.pricing)) return undefined;

	const routeIds = new Set<string>();
	for (const model of catalog.value.models) {
		for (const protocol of model.supported_protocols) {
			const routes = getProviderRouteCandidates(env, model.id, protocol);
			if (!routes.ok || routes.value.some((route) => !route.capacity)) return undefined;
			for (const route of routes.value) routeIds.add(route.id);
		}
	}
	return routeIds.size > 0 ? [...routeIds].sort() : undefined;
}

export function createDependencyHealthService(probes: DependencyProbes = defaultProbes): DependencyHealthService {
	return {
		async check(env) {
			const routeIds = configurationRouteIds(env);
			if (!routeIds) {
				return {
					checks: {
						admission: "not_checked",
						configuration: "failed",
						identity_storage: "not_checked",
						provider_capacity: "not_checked",
						usage_ledger: "not_checked",
					},
					status: "unhealthy",
				};
			}

			const [admission, database, providerPools] = await Promise.all([
				probes.admission(env).catch(() => false),
				probes.database(env).catch(() => ({ identityStorage: false, usageLedger: false })),
				Promise.all(routeIds.map((routeId) => probes.providerPool(env, routeId).catch(() => false))),
			]);
			const checks: DependencyHealthResult["checks"] = {
				admission: admission ? "ok" : "failed",
				configuration: "ok",
				identity_storage: database.identityStorage ? "ok" : "failed",
				provider_capacity: providerPools.every(Boolean) ? "ok" : "failed",
				usage_ledger: database.usageLedger ? "ok" : "failed",
			};
			return {
				checks,
				status: Object.values(checks).every((status) => status === "ok") ? "ok" : "unhealthy",
			};
		},
	};
}

export const dependencyHealthService = createDependencyHealthService();
