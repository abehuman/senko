import { type DatabaseClient, type DatabaseClientFactory, getDatabaseConfig, withDatabaseClient } from "./database";
import type { ApiProtocol, CloudflareBindings, ModelPricing } from "./types";

export const USAGE_ESTIMATOR_VERSION = "utf8-json-bytes-v1";
const MICROS_PER_UNIT = 1_000_000n;

export type UsageLimitDimension =
	| "daily_cost"
	| "max_request_cost"
	| "minute_input_tokens"
	| "minute_output_tokens"
	| "monthly_cost";

type UsageFailureReason =
	| "configuration_error"
	| "conflict"
	| "limit_exceeded"
	| "not_found"
	| "unavailable"
	| "unconfigured";

export type UsageResult<T> =
	| { ok: true; value: T }
	| { dimension?: UsageLimitDimension; message?: string; ok: false; reason: UsageFailureReason };

export interface UsageLimits {
	accountId: string;
	currency: string;
	dailyCostMicrounits: number;
	maxRequestCostMicrounits: number;
	minuteInputTokens: number;
	minuteOutputTokens: number;
	monthlyCostMicrounits: number;
	policyVersion: string;
}

export interface ConfigureUsageLimitsInput extends Omit<UsageLimits, "accountId"> {
	accountId: string;
	requestId: string;
}

export interface ApiKeyUsageLimits extends Omit<UsageLimits, "accountId"> {
	accountId: string;
	apiKeyId: string;
}

export interface ConfigureApiKeyUsageLimitsInput extends Omit<ApiKeyUsageLimits, "accountId" | "apiKeyId"> {
	accountId: string;
	apiKeyId: string;
	requestId: string;
}

export interface ReserveUsageInput {
	accountId: string;
	apiKeyId: string;
	estimatedInputTokens: number;
	providerAttempt: number;
	providerRoute: string;
	protocol: ApiProtocol;
	requestId: string;
	requestedModel: string;
	reservationExpiresAt: Date;
	reservedOutputTokens: number;
	resolvedModel: string;
	pricing: ModelPricing;
}

export interface UsageReservation {
	accountId: string;
	attemptId: string;
	requestId: string;
	reservedCostMicrounits: number;
}

export interface ProviderUsage {
	inputTokens: number;
	outputTokens: number;
}

export type FinalizeUsageInput =
	| {
			accountId: string;
			attemptId: string;
			kind: "conservative_settled";
			terminalReason: string;
	  }
	| {
			accountId: string;
			attemptId: string;
			kind: "released";
			terminalReason: string;
	  }
	| {
			accountId: string;
			attemptId: string;
			kind: "settled";
			terminalReason: string;
			usage: ProviderUsage;
	  };

export interface UsageFinalization {
	overLimitAfterSettlement: boolean;
	settledCostMicrounits: number;
}

export interface UsageReconciliation {
	candidates: number;
	failed: number;
	settled: number;
	skipped: number;
}

export interface UsageService {
	configureApiKeyLimits(
		env: CloudflareBindings,
		input: ConfigureApiKeyUsageLimitsInput,
	): Promise<UsageResult<ApiKeyUsageLimits>>;
	configureLimits(env: CloudflareBindings, input: ConfigureUsageLimitsInput): Promise<UsageResult<UsageLimits>>;
	finalize(env: CloudflareBindings, input: FinalizeUsageInput): Promise<UsageResult<UsageFinalization>>;
	reconcileExpired(env: CloudflareBindings, limit?: number): Promise<UsageResult<UsageReconciliation>>;
	reserve(env: CloudflareBindings, input: ReserveUsageInput): Promise<UsageResult<UsageReservation>>;
}

interface UsageLimitRow {
	account_id: string;
	currency: string;
	daily_cost_microunits: number | string;
	max_request_cost_microunits: number | string;
	minute_input_tokens: number | string;
	minute_output_tokens: number | string;
	monthly_cost_microunits: number | string;
	policy_version: string;
}

interface UsageAttemptRow {
	account_id: string;
	api_key_id: string;
	api_key_policy_version: string | null;
	day_window_start: Date | string;
	estimated_input_tokens: number | string;
	id: string;
	input_price_microunits_per_million_tokens: number | string;
	minute_window_start: Date | string;
	month_window_start: Date | string;
	output_price_microunits_per_million_tokens: number | string;
	pricing_version: string;
	provider_attempt: number;
	provider_route: string;
	protocol: ApiProtocol;
	request_id: string;
	requested_model: string;
	reserved_cost_microunits: number | string;
	reserved_output_tokens: number | string;
	resolved_model: string;
	currency: string;
}

interface UsageBucketRow {
	bucket_type: "day_cost" | "minute_tokens" | "month_cost";
	reserved_cost_microunits: number | string;
	reserved_input_tokens: number | string;
	reserved_output_tokens: number | string;
	settled_cost_microunits: number | string;
	settled_input_tokens: number | string;
	settled_output_tokens: number | string;
}

interface UsageTerminalRow {
	event_type: string;
	over_limit_after_settlement: boolean;
	settled_cost_microunits: number | string;
	settled_input_tokens: number | string;
	settled_output_tokens: number | string;
	terminal_reason: string | null;
}

interface StatusRow {
	status: string;
}

interface ExpiredAttemptRow {
	account_id: string;
	api_key_id: string;
	api_key_policy_version: string | null;
	attempt_id: string;
	day_window_start: Date | string;
	estimated_input_tokens: number | string;
	minute_window_start: Date | string;
	month_window_start: Date | string;
	reserved_cost_microunits: number | string;
	reserved_output_tokens: number | string;
}

interface PendingBucketSettlement {
	accountId: string;
	apiKeyId?: string;
	bucketType: "day_cost" | "minute_tokens" | "month_cost";
	reservedCostMicrounits: number;
	reservedInputTokens: number;
	reservedOutputTokens: number;
	windowStart: Date;
}

interface LockedBucketRow extends UsageBucketRow {
	account_id: string;
	api_key_id?: string;
	window_start: Date | string;
}

function safeInteger(value: number | string): number | undefined {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function limitRecord(row: UsageLimitRow): UsageLimits | undefined {
	const minuteInputTokens = safeInteger(row.minute_input_tokens);
	const minuteOutputTokens = safeInteger(row.minute_output_tokens);
	const maxRequestCostMicrounits = safeInteger(row.max_request_cost_microunits);
	const dailyCostMicrounits = safeInteger(row.daily_cost_microunits);
	const monthlyCostMicrounits = safeInteger(row.monthly_cost_microunits);
	if (
		minuteInputTokens === undefined ||
		minuteOutputTokens === undefined ||
		maxRequestCostMicrounits === undefined ||
		dailyCostMicrounits === undefined ||
		monthlyCostMicrounits === undefined
	) {
		return undefined;
	}
	return {
		accountId: row.account_id,
		currency: row.currency,
		dailyCostMicrounits,
		maxRequestCostMicrounits,
		minuteInputTokens,
		minuteOutputTokens,
		monthlyCostMicrounits,
		policyVersion: row.policy_version,
	};
}

function apiKeyLimitRecord(row: UsageLimitRow & { api_key_id: string }): ApiKeyUsageLimits | undefined {
	const limits = limitRecord(row);
	return limits ? { ...limits, apiKeyId: row.api_key_id } : undefined;
}

function limitsFitWithin(
	apiKeyLimits: Omit<ApiKeyUsageLimits, "accountId" | "apiKeyId">,
	account: UsageLimits,
): boolean {
	return (
		apiKeyLimits.currency === account.currency &&
		apiKeyLimits.minuteInputTokens <= account.minuteInputTokens &&
		apiKeyLimits.minuteOutputTokens <= account.minuteOutputTokens &&
		apiKeyLimits.maxRequestCostMicrounits <= account.maxRequestCostMicrounits &&
		apiKeyLimits.dailyCostMicrounits <= account.dailyCostMicrounits &&
		apiKeyLimits.monthlyCostMicrounits <= account.monthlyCostMicrounits
	);
}

function costMicrounits(usage: ProviderUsage, pricing: ModelPricing): number | undefined {
	if (
		!Number.isSafeInteger(usage.inputTokens) ||
		usage.inputTokens < 0 ||
		!Number.isSafeInteger(usage.outputTokens) ||
		usage.outputTokens < 0 ||
		!Number.isSafeInteger(pricing.input_microunits_per_million_tokens) ||
		pricing.input_microunits_per_million_tokens < 0 ||
		!Number.isSafeInteger(pricing.output_microunits_per_million_tokens) ||
		pricing.output_microunits_per_million_tokens < 0
	) {
		return undefined;
	}
	const numerator =
		BigInt(usage.inputTokens) * BigInt(pricing.input_microunits_per_million_tokens) +
		BigInt(usage.outputTokens) * BigInt(pricing.output_microunits_per_million_tokens);
	const rounded = (numerator + MICROS_PER_UNIT - 1n) / MICROS_PER_UNIT;
	return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : undefined;
}

export function calculateUsageCostMicrounits(usage: ProviderUsage, pricing: ModelPricing): number | undefined {
	return costMicrounits(usage, pricing);
}

export function estimateInputTokens(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function usageWindows(now: Date): { day: Date; minute: Date; month: Date } {
	return {
		day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
		minute: new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()),
		),
		month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
	};
}

async function rollback(client: DatabaseClient): Promise<void> {
	await client.query("rollback").catch(() => undefined);
}

function unavailable<T>(): UsageResult<T> {
	return { ok: false, reason: "unavailable" };
}

function configuration<T>(message: string): UsageResult<T> {
	return { message, ok: false, reason: "configuration_error" };
}

function existingReservationMatches(row: UsageAttemptRow, input: ReserveUsageInput, reservedCost: number): boolean {
	return (
		row.account_id === input.accountId &&
		row.api_key_id === input.apiKeyId &&
		row.provider_attempt === input.providerAttempt &&
		row.provider_route === input.providerRoute &&
		row.protocol === input.protocol &&
		row.requested_model === input.requestedModel &&
		row.resolved_model === input.resolvedModel &&
		row.pricing_version === input.pricing.version &&
		row.currency === input.pricing.currency &&
		safeInteger(row.estimated_input_tokens) === input.estimatedInputTokens &&
		safeInteger(row.reserved_output_tokens) === input.reservedOutputTokens &&
		safeInteger(row.reserved_cost_microunits) === reservedCost &&
		safeInteger(row.input_price_microunits_per_million_tokens) === input.pricing.input_microunits_per_million_tokens &&
		safeInteger(row.output_price_microunits_per_million_tokens) === input.pricing.output_microunits_per_million_tokens
	);
}

function bucketTotal(
	row: UsageBucketRow,
	reservedField: keyof UsageBucketRow,
	settledField: keyof UsageBucketRow,
): number {
	return (safeInteger(row[reservedField]) ?? Number.MAX_SAFE_INTEGER) + (safeInteger(row[settledField]) ?? 0);
}

export function createPostgresUsageService(clientFactory?: DatabaseClientFactory): UsageService {
	const run = async <T>(
		env: CloudflareBindings,
		operation: (client: DatabaseClient) => Promise<UsageResult<T>>,
	): Promise<UsageResult<T>> => {
		const config = getDatabaseConfig(env);
		if (!config.ok) {
			return configuration(config.message);
		}
		try {
			return await withDatabaseClient(config.connectionString, operation, clientFactory);
		} catch {
			return unavailable();
		}
	};

	const service: UsageService = {
		async configureApiKeyLimits(env, input) {
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
					// Shared with account policy updates, key rotation, and reservation:
					// accounts -> account_usage_limits -> api_keys -> api_key_usage_limits.
					const accountLimitsResult = await client.query<UsageLimitRow>(
						`select account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits
						 from account_usage_limits where account_id = $1 for update`,
						[input.accountId],
					);
					const accountLimits = accountLimitsResult.rows[0] ? limitRecord(accountLimitsResult.rows[0]) : undefined;
					if (!accountLimits) {
						await rollback(client);
						return { ok: false, reason: "unconfigured" };
					}
					const key = await client.query<StatusRow>(
						"select status from api_keys where id = $1 and account_id = $2 for update",
						[input.apiKeyId, input.accountId],
					);
					if (!key.rows[0]) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					if (key.rows[0].status !== "active") {
						await rollback(client);
						return { ok: false, reason: "conflict" };
					}
					if (!limitsFitWithin(input, accountLimits)) {
						await rollback(client);
						return {
							message: "API key usage limits must use the account currency and cannot exceed account limits.",
							ok: false,
							reason: "conflict",
						};
					}
					const result = await client.query<UsageLimitRow & { api_key_id: string }>(
						`insert into api_key_usage_limits
							(api_key_id, account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							 max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits)
						 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
						 on conflict (api_key_id) do update set
							policy_version = excluded.policy_version,
							currency = excluded.currency,
							minute_input_tokens = excluded.minute_input_tokens,
							minute_output_tokens = excluded.minute_output_tokens,
							max_request_cost_microunits = excluded.max_request_cost_microunits,
							daily_cost_microunits = excluded.daily_cost_microunits,
							monthly_cost_microunits = excluded.monthly_cost_microunits,
							updated_at = now()
						 where api_key_usage_limits.account_id = excluded.account_id
						 returning api_key_id, account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits`,
						[
							input.apiKeyId,
							input.accountId,
							input.policyVersion,
							input.currency,
							input.minuteInputTokens,
							input.minuteOutputTokens,
							input.maxRequestCostMicrounits,
							input.dailyCostMicrounits,
							input.monthlyCostMicrounits,
						],
					);
					const limits = result.rows[0] ? apiKeyLimitRecord(result.rows[0]) : undefined;
					if (!limits) {
						throw new Error("invalid API key usage limits returned by database");
					}
					await client.query(
						`insert into admin_audit_events
							(account_id, actor_type, action, target_type, target_id, request_id, metadata)
						 values ($1::uuid, 'system', 'api_key_usage_limits.configured', 'api_key_usage_limits', $2::uuid::text, $3, $4::jsonb)`,
						[
							input.accountId,
							input.apiKeyId,
							input.requestId,
							JSON.stringify({ currency: input.currency, policy_version: input.policyVersion }),
						],
					);
					await client.query("commit");
					return { ok: true, value: limits };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async configureLimits(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const account = await client.query<StatusRow>("select status from accounts where id = $1 for update", [
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
					const existingLimits = await client.query<{ currency: string }>(
						"select currency from account_usage_limits where account_id = $1 for update",
						[input.accountId],
					);
					if (existingLimits.rows[0] && existingLimits.rows[0].currency !== input.currency) {
						await rollback(client);
						return {
							message: "The account usage currency cannot change after it has been configured.",
							ok: false,
							reason: "conflict",
						};
					}
					const result = await client.query<UsageLimitRow>(
						`insert into account_usage_limits
							(account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							 max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits)
						 values ($1, $2, $3, $4, $5, $6, $7, $8)
						 on conflict (account_id) do update set
							policy_version = excluded.policy_version,
							currency = excluded.currency,
							minute_input_tokens = excluded.minute_input_tokens,
							minute_output_tokens = excluded.minute_output_tokens,
							max_request_cost_microunits = excluded.max_request_cost_microunits,
							daily_cost_microunits = excluded.daily_cost_microunits,
							monthly_cost_microunits = excluded.monthly_cost_microunits,
							updated_at = now()
						 returning account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits`,
						[
							input.accountId,
							input.policyVersion,
							input.currency,
							input.minuteInputTokens,
							input.minuteOutputTokens,
							input.maxRequestCostMicrounits,
							input.dailyCostMicrounits,
							input.monthlyCostMicrounits,
						],
					);
					const limits = result.rows[0] ? limitRecord(result.rows[0]) : undefined;
					if (!limits) {
						throw new Error("invalid usage limits returned by database");
					}
					await client.query(
						`insert into admin_audit_events
							(account_id, actor_type, action, target_type, target_id, request_id, metadata)
						 values ($1::uuid, 'system', 'usage_limits.configured', 'account_usage_limits', $1::uuid::text, $2, $3::jsonb)`,
						[
							input.accountId,
							input.requestId,
							JSON.stringify({ currency: input.currency, policy_version: input.policyVersion }),
						],
					);
					await client.query("commit");
					return { ok: true, value: limits };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async reserve(env, input) {
			const reservedCost = costMicrounits(
				{ inputTokens: input.estimatedInputTokens, outputTokens: input.reservedOutputTokens },
				input.pricing,
			);
			if (reservedCost === undefined) {
				return configuration("The configured model pricing cannot produce a safe reservation amount.");
			}
			return run(env, async (client) => {
				await client.query("begin");
				try {
					// Lock ownership before policy rows so account/key administration cannot form a cycle
					// through usage_attempts foreign keys. Account and key locks are shared; quota
					// serialization remains on policy and bucket rows.
					await client.query("select id from accounts where id = $1 for share", [input.accountId]);
					const limitsResult = await client.query<UsageLimitRow>(
						`select account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits
						 from account_usage_limits where account_id = $1 for update`,
						[input.accountId],
					);
					const limits = limitsResult.rows[0] ? limitRecord(limitsResult.rows[0]) : undefined;
					if (!limits) {
						await rollback(client);
						return { ok: false, reason: "unconfigured" };
					}
					await client.query("select id from api_keys where id = $1 and account_id = $2 for share", [
						input.apiKeyId,
						input.accountId,
					]);
					const keyLimitsResult = await client.query<UsageLimitRow & { api_key_id: string }>(
						`select api_key_id, account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits
						 from api_key_usage_limits where api_key_id = $1 and account_id = $2 for update`,
						[input.apiKeyId, input.accountId],
					);
					const keyLimits = keyLimitsResult.rows[0] ? apiKeyLimitRecord(keyLimitsResult.rows[0]) : undefined;
					if (keyLimitsResult.rows[0] && !keyLimits) {
						throw new Error("invalid API key usage limits returned by database");
					}
					const existingResult = await client.query<UsageAttemptRow>(
						`select id, request_id, provider_attempt, account_id, api_key_id, api_key_policy_version, protocol, requested_model,
							resolved_model, provider_route, pricing_version, currency,
							input_price_microunits_per_million_tokens, output_price_microunits_per_million_tokens,
							estimated_input_tokens, reserved_output_tokens, reserved_cost_microunits,
							minute_window_start, day_window_start, month_window_start
						 from usage_attempts where request_id = $1 and provider_attempt = $2 for update`,
						[input.requestId, input.providerAttempt],
					);
					const existing = existingResult.rows[0];
					if (existing) {
						if (!existingReservationMatches(existing, input, reservedCost)) {
							await rollback(client);
							return { ok: false, reason: "conflict" };
						}
						await client.query("commit");
						return {
							ok: true,
							value: {
								accountId: input.accountId,
								attemptId: existing.id,
								requestId: input.requestId,
								reservedCostMicrounits: reservedCost,
							},
						};
					}
					if (limits.currency !== input.pricing.currency) {
						await rollback(client);
						return configuration(
							"The account usage-limit currency does not match the selected model pricing currency.",
						);
					}
					if (keyLimits && keyLimits.currency !== input.pricing.currency) {
						await rollback(client);
						return configuration(
							"The API key usage-limit currency does not match the selected model pricing currency.",
						);
					}
					if (
						reservedCost > limits.maxRequestCostMicrounits ||
						(keyLimits !== undefined && reservedCost > keyLimits.maxRequestCostMicrounits)
					) {
						await rollback(client);
						return { dimension: "max_request_cost", ok: false, reason: "limit_exceeded" };
					}

					const windows = usageWindows(new Date());
					await client.query(
						`insert into account_usage_buckets (account_id, bucket_type, window_start)
						 values ($1, 'minute_tokens', $2), ($1, 'day_cost', $3), ($1, 'month_cost', $4)
						 on conflict do nothing`,
						[input.accountId, windows.minute, windows.day, windows.month],
					);
					const bucketsResult = await client.query<UsageBucketRow>(
						`select bucket_type, reserved_input_tokens, reserved_output_tokens, reserved_cost_microunits,
							settled_input_tokens, settled_output_tokens, settled_cost_microunits
						 from account_usage_buckets
						 where account_id = $1 and (
							(bucket_type = 'minute_tokens' and window_start = $2) or
							(bucket_type = 'day_cost' and window_start = $3) or
							(bucket_type = 'month_cost' and window_start = $4)
						 )
						 order by case bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end
						 for update`,
						[input.accountId, windows.minute, windows.day, windows.month],
					);
					const buckets = new Map(bucketsResult.rows.map((row) => [row.bucket_type, row]));
					const minute = buckets.get("minute_tokens");
					const day = buckets.get("day_cost");
					const month = buckets.get("month_cost");
					if (!minute || !day || !month) {
						throw new Error("usage bucket initialization failed");
					}
					if (
						bucketTotal(minute, "reserved_input_tokens", "settled_input_tokens") + input.estimatedInputTokens >
						limits.minuteInputTokens
					) {
						await rollback(client);
						return { dimension: "minute_input_tokens", ok: false, reason: "limit_exceeded" };
					}
					if (
						bucketTotal(minute, "reserved_output_tokens", "settled_output_tokens") + input.reservedOutputTokens >
						limits.minuteOutputTokens
					) {
						await rollback(client);
						return { dimension: "minute_output_tokens", ok: false, reason: "limit_exceeded" };
					}
					if (
						bucketTotal(day, "reserved_cost_microunits", "settled_cost_microunits") + reservedCost >
						limits.dailyCostMicrounits
					) {
						await rollback(client);
						return { dimension: "daily_cost", ok: false, reason: "limit_exceeded" };
					}
					if (
						bucketTotal(month, "reserved_cost_microunits", "settled_cost_microunits") + reservedCost >
						limits.monthlyCostMicrounits
					) {
						await rollback(client);
						return { dimension: "monthly_cost", ok: false, reason: "limit_exceeded" };
					}

					let keyBuckets: Map<UsageBucketRow["bucket_type"], UsageBucketRow> | undefined;
					if (keyLimits) {
						await client.query(
							`insert into api_key_usage_buckets (api_key_id, account_id, bucket_type, window_start)
							 values ($1, $2, 'minute_tokens', $3), ($1, $2, 'day_cost', $4), ($1, $2, 'month_cost', $5)
							 on conflict do nothing`,
							[input.apiKeyId, input.accountId, windows.minute, windows.day, windows.month],
						);
						const keyBucketsResult = await client.query<UsageBucketRow>(
							`select bucket_type, reserved_input_tokens, reserved_output_tokens, reserved_cost_microunits,
								settled_input_tokens, settled_output_tokens, settled_cost_microunits
							 from api_key_usage_buckets
							 where api_key_id = $1 and account_id = $2 and (
								(bucket_type = 'minute_tokens' and window_start = $3) or
								(bucket_type = 'day_cost' and window_start = $4) or
								(bucket_type = 'month_cost' and window_start = $5)
							 )
							 order by case bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end
							 for update`,
							[input.apiKeyId, input.accountId, windows.minute, windows.day, windows.month],
						);
						keyBuckets = new Map(keyBucketsResult.rows.map((row) => [row.bucket_type, row]));
						const keyMinute = keyBuckets.get("minute_tokens");
						const keyDay = keyBuckets.get("day_cost");
						const keyMonth = keyBuckets.get("month_cost");
						if (!keyMinute || !keyDay || !keyMonth) {
							throw new Error("API key usage bucket initialization failed");
						}
						if (
							bucketTotal(keyMinute, "reserved_input_tokens", "settled_input_tokens") + input.estimatedInputTokens >
							keyLimits.minuteInputTokens
						) {
							await rollback(client);
							return { dimension: "minute_input_tokens", ok: false, reason: "limit_exceeded" };
						}
						if (
							bucketTotal(keyMinute, "reserved_output_tokens", "settled_output_tokens") + input.reservedOutputTokens >
							keyLimits.minuteOutputTokens
						) {
							await rollback(client);
							return { dimension: "minute_output_tokens", ok: false, reason: "limit_exceeded" };
						}
						if (
							bucketTotal(keyDay, "reserved_cost_microunits", "settled_cost_microunits") + reservedCost >
							keyLimits.dailyCostMicrounits
						) {
							await rollback(client);
							return { dimension: "daily_cost", ok: false, reason: "limit_exceeded" };
						}
						if (
							bucketTotal(keyMonth, "reserved_cost_microunits", "settled_cost_microunits") + reservedCost >
							keyLimits.monthlyCostMicrounits
						) {
							await rollback(client);
							return { dimension: "monthly_cost", ok: false, reason: "limit_exceeded" };
						}
					}

					const attempt = await client.query<{ id: string }>(
						`insert into usage_attempts
							(request_id, provider_attempt, account_id, api_key_id, protocol, requested_model, resolved_model,
							 provider_route, pricing_version, policy_version, api_key_policy_version, currency,
							 input_price_microunits_per_million_tokens, output_price_microunits_per_million_tokens,
							 estimator_version, estimated_input_tokens, reserved_output_tokens, reserved_cost_microunits,
							 minute_window_start, day_window_start, month_window_start, reservation_expires_at)
						 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
						 returning id`,
						[
							input.requestId,
							input.providerAttempt,
							input.accountId,
							input.apiKeyId,
							input.protocol,
							input.requestedModel,
							input.resolvedModel,
							input.providerRoute,
							input.pricing.version,
							limits.policyVersion,
							keyLimits?.policyVersion ?? null,
							input.pricing.currency,
							input.pricing.input_microunits_per_million_tokens,
							input.pricing.output_microunits_per_million_tokens,
							USAGE_ESTIMATOR_VERSION,
							input.estimatedInputTokens,
							input.reservedOutputTokens,
							reservedCost,
							windows.minute,
							windows.day,
							windows.month,
							input.reservationExpiresAt,
						],
					);
					const attemptId = attempt.rows[0]?.id;
					if (!attemptId) {
						throw new Error("usage attempt creation failed");
					}
					await client.query(
						`insert into usage_pending_reservations (attempt_id, account_id, expires_at)
						 values ($1, $2, $3)`,
						[attemptId, input.accountId, input.reservationExpiresAt],
					);
					await client.query(
						`insert into usage_ledger_entries
							(attempt_id, account_id, phase, event_type, reserved_input_tokens,
							 reserved_output_tokens, reserved_cost_microunits, usage_source)
						 values ($1, $2, 'reservation', 'reserved', $3, $4, $5, 'none')`,
						[attemptId, input.accountId, input.estimatedInputTokens, input.reservedOutputTokens, reservedCost],
					);
					await client.query(
						`update account_usage_buckets set
							reserved_input_tokens = reserved_input_tokens + $3,
							reserved_output_tokens = reserved_output_tokens + $4,
							updated_at = now()
						 where account_id = $1 and bucket_type = 'minute_tokens' and window_start = $2`,
						[input.accountId, windows.minute, input.estimatedInputTokens, input.reservedOutputTokens],
					);
					for (const [bucketType, window] of [
						["day_cost", windows.day],
						["month_cost", windows.month],
					] as const) {
						await client.query(
							`update account_usage_buckets set
								reserved_cost_microunits = reserved_cost_microunits + $4,
								updated_at = now()
							 where account_id = $1 and bucket_type = $2 and window_start = $3`,
							[input.accountId, bucketType, window, reservedCost],
						);
					}
					if (keyLimits && keyBuckets) {
						await client.query(
							`update api_key_usage_buckets set
								reserved_input_tokens = reserved_input_tokens + $4,
								reserved_output_tokens = reserved_output_tokens + $5,
								updated_at = now()
							 where api_key_id = $1 and account_id = $2 and bucket_type = 'minute_tokens' and window_start = $3`,
							[input.apiKeyId, input.accountId, windows.minute, input.estimatedInputTokens, input.reservedOutputTokens],
						);
						for (const [bucketType, window] of [
							["day_cost", windows.day],
							["month_cost", windows.month],
						] as const) {
							await client.query(
								`update api_key_usage_buckets set
									reserved_cost_microunits = reserved_cost_microunits + $5,
									updated_at = now()
								 where api_key_id = $1 and account_id = $2 and bucket_type = $3 and window_start = $4`,
								[input.apiKeyId, input.accountId, bucketType, window, reservedCost],
							);
						}
					}
					await client.query("commit");
					return {
						ok: true,
						value: {
							accountId: input.accountId,
							attemptId,
							requestId: input.requestId,
							reservedCostMicrounits: reservedCost,
						},
					};
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async finalize(env, input) {
			return run(env, async (client) => {
				await client.query("begin");
				try {
					await client.query(
						`select attempt_id from usage_pending_reservations
						 where attempt_id = $1 and account_id = $2 for update`,
						[input.attemptId, input.accountId],
					);
					const attemptResult = await client.query<UsageAttemptRow>(
						`select id, request_id, provider_attempt, account_id, api_key_id, api_key_policy_version, protocol, requested_model,
							resolved_model, provider_route, pricing_version, currency,
							input_price_microunits_per_million_tokens, output_price_microunits_per_million_tokens,
							estimated_input_tokens, reserved_output_tokens, reserved_cost_microunits,
							minute_window_start, day_window_start, month_window_start
						 from usage_attempts where id = $1 and account_id = $2 for update`,
						[input.attemptId, input.accountId],
					);
					const attempt = attemptResult.rows[0];
					if (!attempt) {
						await rollback(client);
						return { ok: false, reason: "not_found" };
					}
					const reservedInput = safeInteger(attempt.estimated_input_tokens);
					const reservedOutput = safeInteger(attempt.reserved_output_tokens);
					const reservedCost = safeInteger(attempt.reserved_cost_microunits);
					const inputPrice = safeInteger(attempt.input_price_microunits_per_million_tokens);
					const outputPrice = safeInteger(attempt.output_price_microunits_per_million_tokens);
					if (
						reservedInput === undefined ||
						reservedOutput === undefined ||
						reservedCost === undefined ||
						inputPrice === undefined ||
						outputPrice === undefined
					) {
						throw new Error("invalid usage attempt amounts");
					}
					let settledUsage: ProviderUsage;
					if (input.kind === "released") {
						settledUsage = { inputTokens: 0, outputTokens: 0 };
					} else if (input.kind === "conservative_settled") {
						settledUsage = { inputTokens: reservedInput, outputTokens: reservedOutput };
					} else {
						settledUsage = input.usage;
					}
					const settledCost =
						input.kind === "released"
							? 0
							: costMicrounits(settledUsage, {
									currency: attempt.currency,
									input_microunits_per_million_tokens: inputPrice,
									output_microunits_per_million_tokens: outputPrice,
									version: attempt.pricing_version,
								});
					if (settledCost === undefined) {
						throw new Error("invalid provider usage amounts");
					}

					const existingResult = await client.query<UsageTerminalRow>(
						`select event_type, terminal_reason, settled_input_tokens, settled_output_tokens, settled_cost_microunits,
							over_limit_after_settlement
						 from usage_ledger_entries where attempt_id = $1 and phase = 'terminal' for update`,
						[input.attemptId],
					);
					const existing = existingResult.rows[0];
					if (existing) {
						const matches =
							existing.event_type === input.kind &&
							existing.terminal_reason === input.terminalReason &&
							safeInteger(existing.settled_input_tokens) === settledUsage.inputTokens &&
							safeInteger(existing.settled_output_tokens) === settledUsage.outputTokens &&
							safeInteger(existing.settled_cost_microunits) === settledCost;
						await client.query(matches ? "commit" : "rollback");
						return matches
							? {
									ok: true,
									value: {
										overLimitAfterSettlement: existing.over_limit_after_settlement,
										settledCostMicrounits: settledCost,
									},
								}
							: { ok: false, reason: "conflict" };
					}

					const windows = {
						day: new Date(attempt.day_window_start),
						minute: new Date(attempt.minute_window_start),
						month: new Date(attempt.month_window_start),
					};
					const hasApiKeyLimits = typeof attempt.api_key_policy_version === "string";
					const bucketsResult = await client.query<UsageBucketRow>(
						`select bucket_type, reserved_input_tokens, reserved_output_tokens, reserved_cost_microunits,
							settled_input_tokens, settled_output_tokens, settled_cost_microunits
						 from account_usage_buckets
						 where account_id = $1 and (
							(bucket_type = 'minute_tokens' and window_start = $2) or
							(bucket_type = 'day_cost' and window_start = $3) or
							(bucket_type = 'month_cost' and window_start = $4)
						 )
						 order by case bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end
						 for update`,
						[input.accountId, windows.minute, windows.day, windows.month],
					);
					const buckets = new Map(bucketsResult.rows.map((row) => [row.bucket_type, row]));
					const minuteBucket = buckets.get("minute_tokens");
					const dayBucket = buckets.get("day_cost");
					const monthBucket = buckets.get("month_cost");
					if (!minuteBucket || !dayBucket || !monthBucket) {
						throw new Error("usage settlement buckets are missing");
					}
					let keyMinuteBucket: UsageBucketRow | undefined;
					let keyDayBucket: UsageBucketRow | undefined;
					let keyMonthBucket: UsageBucketRow | undefined;
					if (hasApiKeyLimits) {
						const keyBucketsResult = await client.query<UsageBucketRow>(
							`select bucket_type, reserved_input_tokens, reserved_output_tokens, reserved_cost_microunits,
								settled_input_tokens, settled_output_tokens, settled_cost_microunits
							 from api_key_usage_buckets
							 where api_key_id = $1 and account_id = $2 and (
								(bucket_type = 'minute_tokens' and window_start = $3) or
								(bucket_type = 'day_cost' and window_start = $4) or
								(bucket_type = 'month_cost' and window_start = $5)
							 )
							 order by case bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end
							 for update`,
							[attempt.api_key_id, input.accountId, windows.minute, windows.day, windows.month],
						);
						const keyBuckets = new Map(keyBucketsResult.rows.map((row) => [row.bucket_type, row]));
						keyMinuteBucket = keyBuckets.get("minute_tokens");
						keyDayBucket = keyBuckets.get("day_cost");
						keyMonthBucket = keyBuckets.get("month_cost");
						if (!keyMinuteBucket || !keyDayBucket || !keyMonthBucket) {
							throw new Error("API key usage settlement buckets are missing");
						}
					}
					const minuteUpdate = await client.query(
						`update account_usage_buckets set
							reserved_input_tokens = reserved_input_tokens - $3,
							reserved_output_tokens = reserved_output_tokens - $4,
							settled_input_tokens = settled_input_tokens + $5,
							settled_output_tokens = settled_output_tokens + $6,
							updated_at = now()
						 where account_id = $1 and bucket_type = 'minute_tokens' and window_start = $2
							and reserved_input_tokens >= $3 and reserved_output_tokens >= $4`,
						[
							input.accountId,
							windows.minute,
							reservedInput,
							reservedOutput,
							settledUsage.inputTokens,
							settledUsage.outputTokens,
						],
					);
					if (minuteUpdate.rowCount !== 1) {
						throw new Error("usage token reservation is missing");
					}
					for (const [bucketType, window] of [
						["day_cost", windows.day],
						["month_cost", windows.month],
					] as const) {
						const update = await client.query(
							`update account_usage_buckets set
								reserved_cost_microunits = reserved_cost_microunits - $4,
								settled_cost_microunits = settled_cost_microunits + $5,
								updated_at = now()
							 where account_id = $1 and bucket_type = $2 and window_start = $3
								and reserved_cost_microunits >= $4`,
							[input.accountId, bucketType, window, reservedCost, settledCost],
						);
						if (update.rowCount !== 1) {
							throw new Error("usage cost reservation is missing");
						}
					}
					if (hasApiKeyLimits) {
						const keyMinuteUpdate = await client.query(
							`update api_key_usage_buckets set
								reserved_input_tokens = reserved_input_tokens - $4,
								reserved_output_tokens = reserved_output_tokens - $5,
								settled_input_tokens = settled_input_tokens + $6,
								settled_output_tokens = settled_output_tokens + $7,
								updated_at = now()
							 where api_key_id = $1 and account_id = $2 and bucket_type = 'minute_tokens' and window_start = $3
								and reserved_input_tokens >= $4 and reserved_output_tokens >= $5`,
							[
								attempt.api_key_id,
								input.accountId,
								windows.minute,
								reservedInput,
								reservedOutput,
								settledUsage.inputTokens,
								settledUsage.outputTokens,
							],
						);
						if (keyMinuteUpdate.rowCount !== 1) {
							throw new Error("API key usage token reservation is missing");
						}
						for (const [bucketType, window] of [
							["day_cost", windows.day],
							["month_cost", windows.month],
						] as const) {
							const update = await client.query(
								`update api_key_usage_buckets set
									reserved_cost_microunits = reserved_cost_microunits - $5,
									settled_cost_microunits = settled_cost_microunits + $6,
									updated_at = now()
								 where api_key_id = $1 and account_id = $2 and bucket_type = $3 and window_start = $4
									and reserved_cost_microunits >= $5`,
								[attempt.api_key_id, input.accountId, bucketType, window, reservedCost, settledCost],
							);
							if (update.rowCount !== 1) {
								throw new Error("API key usage cost reservation is missing");
							}
						}
					}
					const deletedPending = await client.query(
						"delete from usage_pending_reservations where attempt_id = $1 and account_id = $2",
						[input.attemptId, input.accountId],
					);
					if (deletedPending.rowCount !== 1) {
						throw new Error("usage pending reservation is missing");
					}
					const limitsResult = await client.query<UsageLimitRow>(
						`select account_id, policy_version, currency, minute_input_tokens, minute_output_tokens,
							max_request_cost_microunits, daily_cost_microunits, monthly_cost_microunits
						 from account_usage_limits where account_id = $1`,
						[input.accountId],
					);
					const limits = limitsResult.rows[0] ? limitRecord(limitsResult.rows[0]) : undefined;
					const keyLimitsResult = !hasApiKeyLimits
						? undefined
						: await client.query<UsageLimitRow & { api_key_id: string }>(
								`select api_key_id, account_id, policy_version, currency, minute_input_tokens,
										minute_output_tokens, max_request_cost_microunits, daily_cost_microunits,
										monthly_cost_microunits
									 from api_key_usage_limits where api_key_id = $1 and account_id = $2`,
								[attempt.api_key_id, input.accountId],
							);
					const keyLimits = keyLimitsResult?.rows[0] ? apiKeyLimitRecord(keyLimitsResult.rows[0]) : undefined;
					const afterSettlement = (
						row: UsageBucketRow,
						reservedField: keyof UsageBucketRow,
						settledField: keyof UsageBucketRow,
						released: number,
						settled: number,
					): number => {
						const reservedBefore = safeInteger(row[reservedField]);
						const settledBefore = safeInteger(row[settledField]);
						if (reservedBefore === undefined || settledBefore === undefined || reservedBefore < released) {
							return Number.MAX_SAFE_INTEGER;
						}
						return reservedBefore - released + settledBefore + settled;
					};
					const accountOverLimitAfterSettlement =
						limits !== undefined &&
						(afterSettlement(
							minuteBucket,
							"reserved_input_tokens",
							"settled_input_tokens",
							reservedInput,
							settledUsage.inputTokens,
						) > limits.minuteInputTokens ||
							afterSettlement(
								minuteBucket,
								"reserved_output_tokens",
								"settled_output_tokens",
								reservedOutput,
								settledUsage.outputTokens,
							) > limits.minuteOutputTokens ||
							afterSettlement(
								dayBucket,
								"reserved_cost_microunits",
								"settled_cost_microunits",
								reservedCost,
								settledCost,
							) > limits.dailyCostMicrounits ||
							afterSettlement(
								monthBucket,
								"reserved_cost_microunits",
								"settled_cost_microunits",
								reservedCost,
								settledCost,
							) > limits.monthlyCostMicrounits);
					const keyOverLimitAfterSettlement =
						keyLimits !== undefined &&
						keyMinuteBucket !== undefined &&
						keyDayBucket !== undefined &&
						keyMonthBucket !== undefined &&
						(afterSettlement(
							keyMinuteBucket,
							"reserved_input_tokens",
							"settled_input_tokens",
							reservedInput,
							settledUsage.inputTokens,
						) > keyLimits.minuteInputTokens ||
							afterSettlement(
								keyMinuteBucket,
								"reserved_output_tokens",
								"settled_output_tokens",
								reservedOutput,
								settledUsage.outputTokens,
							) > keyLimits.minuteOutputTokens ||
							afterSettlement(
								keyDayBucket,
								"reserved_cost_microunits",
								"settled_cost_microunits",
								reservedCost,
								settledCost,
							) > keyLimits.dailyCostMicrounits ||
							afterSettlement(
								keyMonthBucket,
								"reserved_cost_microunits",
								"settled_cost_microunits",
								reservedCost,
								settledCost,
							) > keyLimits.monthlyCostMicrounits);
					const overLimitAfterSettlement = accountOverLimitAfterSettlement || keyOverLimitAfterSettlement;
					const source = input.kind === "settled" ? "provider" : input.kind === "released" ? "none" : "reservation";
					await client.query(
						`insert into usage_ledger_entries
							(attempt_id, account_id, phase, event_type, released_input_tokens, released_output_tokens,
							 released_cost_microunits, settled_input_tokens, settled_output_tokens, settled_cost_microunits,
							 usage_source, terminal_reason, over_limit_after_settlement)
						 values ($1, $2, 'terminal', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
						[
							input.attemptId,
							input.accountId,
							input.kind,
							reservedInput,
							reservedOutput,
							reservedCost,
							settledUsage.inputTokens,
							settledUsage.outputTokens,
							settledCost,
							source,
							input.terminalReason,
							overLimitAfterSettlement,
						],
					);
					await client.query("commit");
					return { ok: true, value: { overLimitAfterSettlement, settledCostMicrounits: settledCost } };
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},

		async reconcileExpired(env, limit = 100) {
			const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 100;
			return run(env, async (client) => {
				await client.query("begin");
				try {
					const candidatesResult = await client.query<ExpiredAttemptRow>(
						`select p.attempt_id, p.account_id, a.api_key_id, a.api_key_policy_version,
							a.estimated_input_tokens, a.reserved_output_tokens,
							a.reserved_cost_microunits, a.minute_window_start, a.day_window_start, a.month_window_start
						 from usage_pending_reservations p
						 join usage_attempts a on a.id = p.attempt_id and a.account_id = p.account_id
						 where p.expires_at <= now()
						 order by p.expires_at, p.attempt_id
						 limit $1
						 for update of p skip locked`,
						[boundedLimit],
					);
					const candidates = candidatesResult.rows;
					if (candidates.length === 0) {
						await client.query("commit");
						return { ok: true, value: { candidates: 0, failed: 0, settled: 0, skipped: 0 } };
					}

					const bucketGroups = new Map<string, PendingBucketSettlement>();
					const keyBucketGroups = new Map<string, PendingBucketSettlement>();
					const addBucket = (bucket: PendingBucketSettlement): void => {
						const key = `${bucket.accountId}:${bucket.bucketType}:${bucket.windowStart.toISOString()}`;
						const existing = bucketGroups.get(key);
						if (existing) {
							existing.reservedInputTokens += bucket.reservedInputTokens;
							existing.reservedOutputTokens += bucket.reservedOutputTokens;
							existing.reservedCostMicrounits += bucket.reservedCostMicrounits;
							if (
								!Number.isSafeInteger(existing.reservedInputTokens) ||
								!Number.isSafeInteger(existing.reservedOutputTokens) ||
								!Number.isSafeInteger(existing.reservedCostMicrounits)
							) {
								throw new Error("expired usage reservation totals exceed safe integer range");
							}
							return;
						}
						bucketGroups.set(key, bucket);
					};
					const addKeyBucket = (bucket: PendingBucketSettlement & { apiKeyId: string }): void => {
						const key = `${bucket.accountId}:${bucket.apiKeyId}:${bucket.bucketType}:${bucket.windowStart.toISOString()}`;
						const existing = keyBucketGroups.get(key);
						if (existing) {
							existing.reservedInputTokens += bucket.reservedInputTokens;
							existing.reservedOutputTokens += bucket.reservedOutputTokens;
							existing.reservedCostMicrounits += bucket.reservedCostMicrounits;
							if (
								!Number.isSafeInteger(existing.reservedInputTokens) ||
								!Number.isSafeInteger(existing.reservedOutputTokens) ||
								!Number.isSafeInteger(existing.reservedCostMicrounits)
							) {
								throw new Error("expired API key usage reservation totals exceed safe integer range");
							}
							return;
						}
						keyBucketGroups.set(key, bucket);
					};

					for (const candidate of candidates) {
						const reservedInputTokens = safeInteger(candidate.estimated_input_tokens);
						const reservedOutputTokens = safeInteger(candidate.reserved_output_tokens);
						const reservedCostMicrounits = safeInteger(candidate.reserved_cost_microunits);
						const minute = new Date(candidate.minute_window_start);
						const day = new Date(candidate.day_window_start);
						const month = new Date(candidate.month_window_start);
						if (
							reservedInputTokens === undefined ||
							reservedOutputTokens === undefined ||
							reservedCostMicrounits === undefined ||
							Number.isNaN(minute.getTime()) ||
							Number.isNaN(day.getTime()) ||
							Number.isNaN(month.getTime())
						) {
							throw new Error("invalid expired usage reservation");
						}
						addBucket({
							accountId: candidate.account_id,
							bucketType: "minute_tokens",
							reservedCostMicrounits: 0,
							reservedInputTokens,
							reservedOutputTokens,
							windowStart: minute,
						});
						for (const [bucketType, windowStart] of [
							["day_cost", day],
							["month_cost", month],
						] as const) {
							addBucket({
								accountId: candidate.account_id,
								bucketType,
								reservedCostMicrounits,
								reservedInputTokens: 0,
								reservedOutputTokens: 0,
								windowStart,
							});
						}
						if (typeof candidate.api_key_policy_version === "string") {
							addKeyBucket({
								accountId: candidate.account_id,
								apiKeyId: candidate.api_key_id,
								bucketType: "minute_tokens",
								reservedCostMicrounits: 0,
								reservedInputTokens,
								reservedOutputTokens,
								windowStart: minute,
							});
							for (const [bucketType, windowStart] of [
								["day_cost", day],
								["month_cost", month],
							] as const) {
								addKeyBucket({
									accountId: candidate.account_id,
									apiKeyId: candidate.api_key_id,
									bucketType,
									reservedCostMicrounits,
									reservedInputTokens: 0,
									reservedOutputTokens: 0,
									windowStart,
								});
							}
						}
					}

					const buckets = [...bucketGroups.values()].sort(
						(left, right) =>
							left.accountId.localeCompare(right.accountId) ||
							["minute_tokens", "day_cost", "month_cost"].indexOf(left.bucketType) -
								["minute_tokens", "day_cost", "month_cost"].indexOf(right.bucketType) ||
							left.windowStart.getTime() - right.windowStart.getTime(),
					);
					const bucketParameters: unknown[] = [];
					const bucketValues = buckets
						.map((bucket, index) => {
							const offset = index * 6;
							bucketParameters.push(
								bucket.accountId,
								bucket.bucketType,
								bucket.windowStart,
								bucket.reservedInputTokens,
								bucket.reservedOutputTokens,
								bucket.reservedCostMicrounits,
							);
							return `($${offset + 1}::uuid, $${offset + 2}::varchar, $${offset + 3}::timestamptz, $${offset + 4}::bigint, $${offset + 5}::bigint, $${offset + 6}::bigint)`;
						})
						.join(", ");
					const lockedBuckets = await client.query<LockedBucketRow>(
						`select b.account_id, b.bucket_type, b.window_start, b.reserved_input_tokens,
							b.reserved_output_tokens, b.reserved_cost_microunits,
							b.settled_input_tokens, b.settled_output_tokens, b.settled_cost_microunits
						 from account_usage_buckets b
						 join (values ${bucketValues}) as v
							(account_id, bucket_type, window_start, reserved_input_tokens, reserved_output_tokens, reserved_cost_microunits)
						 on b.account_id = v.account_id and b.bucket_type = v.bucket_type and b.window_start = v.window_start
						 order by b.account_id,
							case b.bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end,
							b.window_start
						 for update of b`,
						bucketParameters,
					);
					if (lockedBuckets.rows.length !== buckets.length) {
						throw new Error("expired usage reservation buckets are missing");
					}
					for (const row of lockedBuckets.rows) {
						const key = `${row.account_id}:${row.bucket_type}:${new Date(row.window_start).toISOString()}`;
						const expected = bucketGroups.get(key);
						if (
							!expected ||
							(safeInteger(row.reserved_input_tokens) ?? -1) < expected.reservedInputTokens ||
							(safeInteger(row.reserved_output_tokens) ?? -1) < expected.reservedOutputTokens ||
							(safeInteger(row.reserved_cost_microunits) ?? -1) < expected.reservedCostMicrounits
						) {
							throw new Error("expired usage reservation bucket totals are inconsistent");
						}
					}

					const bucketUpdate = await client.query(
						`update account_usage_buckets b set
							reserved_input_tokens = b.reserved_input_tokens - v.reserved_input_tokens,
							reserved_output_tokens = b.reserved_output_tokens - v.reserved_output_tokens,
							reserved_cost_microunits = b.reserved_cost_microunits - v.reserved_cost_microunits,
							settled_input_tokens = b.settled_input_tokens + v.reserved_input_tokens,
							settled_output_tokens = b.settled_output_tokens + v.reserved_output_tokens,
							settled_cost_microunits = b.settled_cost_microunits + v.reserved_cost_microunits,
							updated_at = now()
						 from (values ${bucketValues}) as v
							(account_id, bucket_type, window_start, reserved_input_tokens, reserved_output_tokens, reserved_cost_microunits)
						 where b.account_id = v.account_id and b.bucket_type = v.bucket_type and b.window_start = v.window_start`,
						bucketParameters,
					);
					if (bucketUpdate.rowCount !== buckets.length) {
						throw new Error("expired usage reservation bucket update was incomplete");
					}

					const keyBuckets = [...keyBucketGroups.values()].sort(
						(left, right) =>
							left.accountId.localeCompare(right.accountId) ||
							(left.apiKeyId ?? "").localeCompare(right.apiKeyId ?? "") ||
							["minute_tokens", "day_cost", "month_cost"].indexOf(left.bucketType) -
								["minute_tokens", "day_cost", "month_cost"].indexOf(right.bucketType) ||
							left.windowStart.getTime() - right.windowStart.getTime(),
					);
					if (keyBuckets.length > 0) {
						const keyBucketParameters: unknown[] = [];
						const keyBucketValues = keyBuckets
							.map((bucket, index) => {
								const offset = index * 7;
								keyBucketParameters.push(
									bucket.apiKeyId,
									bucket.accountId,
									bucket.bucketType,
									bucket.windowStart,
									bucket.reservedInputTokens,
									bucket.reservedOutputTokens,
									bucket.reservedCostMicrounits,
								);
								return `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::varchar, $${offset + 4}::timestamptz, $${offset + 5}::bigint, $${offset + 6}::bigint, $${offset + 7}::bigint)`;
							})
							.join(", ");
						const lockedKeyBuckets = await client.query<LockedBucketRow>(
							`select b.api_key_id, b.account_id, b.bucket_type, b.window_start, b.reserved_input_tokens,
								b.reserved_output_tokens, b.reserved_cost_microunits,
								b.settled_input_tokens, b.settled_output_tokens, b.settled_cost_microunits
							 from api_key_usage_buckets b
							 join (values ${keyBucketValues}) as v
								(api_key_id, account_id, bucket_type, window_start, reserved_input_tokens,
								 reserved_output_tokens, reserved_cost_microunits)
							 on b.api_key_id = v.api_key_id and b.account_id = v.account_id
								and b.bucket_type = v.bucket_type and b.window_start = v.window_start
							 order by b.account_id, b.api_key_id,
								case b.bucket_type when 'minute_tokens' then 1 when 'day_cost' then 2 else 3 end,
								b.window_start
							 for update of b`,
							keyBucketParameters,
						);
						if (lockedKeyBuckets.rows.length !== keyBuckets.length) {
							throw new Error("expired API key usage reservation buckets are missing");
						}
						for (const row of lockedKeyBuckets.rows) {
							const key = `${row.account_id}:${row.api_key_id}:${row.bucket_type}:${new Date(row.window_start).toISOString()}`;
							const expected = keyBucketGroups.get(key);
							if (
								!expected ||
								(safeInteger(row.reserved_input_tokens) ?? -1) < expected.reservedInputTokens ||
								(safeInteger(row.reserved_output_tokens) ?? -1) < expected.reservedOutputTokens ||
								(safeInteger(row.reserved_cost_microunits) ?? -1) < expected.reservedCostMicrounits
							) {
								throw new Error("expired API key usage reservation bucket totals are inconsistent");
							}
						}
						const keyBucketUpdate = await client.query(
							`update api_key_usage_buckets b set
								reserved_input_tokens = b.reserved_input_tokens - v.reserved_input_tokens,
								reserved_output_tokens = b.reserved_output_tokens - v.reserved_output_tokens,
								reserved_cost_microunits = b.reserved_cost_microunits - v.reserved_cost_microunits,
								settled_input_tokens = b.settled_input_tokens + v.reserved_input_tokens,
								settled_output_tokens = b.settled_output_tokens + v.reserved_output_tokens,
								settled_cost_microunits = b.settled_cost_microunits + v.reserved_cost_microunits,
								updated_at = now()
							 from (values ${keyBucketValues}) as v
								(api_key_id, account_id, bucket_type, window_start, reserved_input_tokens,
								 reserved_output_tokens, reserved_cost_microunits)
							 where b.api_key_id = v.api_key_id and b.account_id = v.account_id
								and b.bucket_type = v.bucket_type and b.window_start = v.window_start`,
							keyBucketParameters,
						);
						if (keyBucketUpdate.rowCount !== keyBuckets.length) {
							throw new Error("expired API key usage reservation bucket update was incomplete");
						}
					}

					const attemptIds = candidates.map((candidate) => candidate.attempt_id);
					const ledgerInsert = await client.query(
						`insert into usage_ledger_entries
							(attempt_id, account_id, phase, event_type, released_input_tokens, released_output_tokens,
							 released_cost_microunits, settled_input_tokens, settled_output_tokens, settled_cost_microunits,
							 usage_source, terminal_reason)
						 select a.id, a.account_id, 'terminal', 'conservative_settled', a.estimated_input_tokens,
							a.reserved_output_tokens, a.reserved_cost_microunits, a.estimated_input_tokens,
							a.reserved_output_tokens, a.reserved_cost_microunits, 'reservation', 'reservation_expired'
						 from usage_attempts a where a.id = any($1::uuid[])`,
						[attemptIds],
					);
					if (ledgerInsert.rowCount !== candidates.length) {
						throw new Error("expired usage reservation ledger insert was incomplete");
					}
					const pendingDelete = await client.query(
						"delete from usage_pending_reservations where attempt_id = any($1::uuid[])",
						[attemptIds],
					);
					if (pendingDelete.rowCount !== candidates.length) {
						throw new Error("expired usage reservation deletion was incomplete");
					}
					await client.query("commit");
					return {
						ok: true,
						value: { candidates: candidates.length, failed: 0, settled: candidates.length, skipped: 0 },
					};
				} catch (error) {
					await rollback(client);
					throw error;
				}
			});
		},
	};
	return service;
}

export const postgresUsageService = createPostgresUsageService();
