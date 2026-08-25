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
				const result = await client.query<{
					identity_ready: boolean;
					ledger_ready: boolean;
				}>(`select
					to_regclass('public.accounts') is not null
						and to_regclass('public.api_keys') is not null
						and to_regclass('public.api_key_scopes') is not null as identity_ready,
					to_regclass('public.account_usage_limits') is not null
						and to_regclass('public.api_key_usage_limits') is not null
						and to_regclass('public.api_key_usage_buckets') is not null
						and to_regclass('public.request_traces') is not null
						and to_regclass('public.usage_attempts') is not null
						and to_regclass('public.usage_ledger_entries') is not null
						and to_regclass('public.usage_pending_reservations') is not null as ledger_ready`);
				const row = result.rows[0];
				return { identityStorage: row?.identity_ready === true, usageLedger: row?.ledger_ready === true };
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
