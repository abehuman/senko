import { type DatabaseClient, type DatabaseClientFactory, getDatabaseConfig, withDatabaseClient } from "./database";
import type { FailureCategory } from "./observability";
import type { CloudflareBindings } from "./types";

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;
const MAX_ATTEMPTS_PER_TRACE = 16;

type SupportFailureReason = "configuration_error" | "not_found" | "unavailable";
export type RequestTraceEndpoint = "chat_completions" | "models" | "responses";
export type PersistedRequestTraceEndpoint = Exclude<RequestTraceEndpoint, "models">;
const PERSISTED_REQUEST_TRACE_ENDPOINTS = new Set<PersistedRequestTraceEndpoint>(["chat_completions", "responses"]);

export type SupportResult<T> = { ok: true; value: T } | { message?: string; ok: false; reason: SupportFailureReason };

export interface RequestLedgerEntry {
	createdAt: string;
	eventType: string;
	phase: string;
	releasedCostMicrounits: number;
	releasedInputTokens: number;
	releasedOutputTokens: number;
	reservedCostMicrounits: number;
	reservedInputTokens: number;
	reservedOutputTokens: number;
	settledCostMicrounits: number;
	settledInputTokens: number;
	settledOutputTokens: number;
	terminalReason: string | null;
	usageSource: string;
}

export interface RequestAttemptTrace {
	accountId: string;
	apiKeyId: string;
	attemptId: string;
	createdAt: string;
	currency: string;
	estimatedInputTokens: number;
	ledger: RequestLedgerEntry[];
	pendingReservation: boolean;
	policyVersion: string;
	pricingVersion: string;
	protocol: string;
	providerAttempt: number;
	providerRoute: string;
	requestedModel: string;
	reservationExpiresAt: string;
	reservedCostMicrounits: number;
	reservedOutputTokens: number;
	resolvedModel: string;
}

export interface RequestTrace {
	accountId: string;
	apiKeyId: string;
	attempts: RequestAttemptTrace[];
	completedAt: string;
	endpoint: RequestTraceEndpoint;
	failureCategory: FailureCategory | null;
	hasMore: boolean;
	httpStatus: number;
	method: "GET" | "POST";
	requestId: string;
	startedAt: string;
}

export interface RecordRequestInput {
	accountId: string;
	apiKeyId: string;
	completedAt: Date;
	endpoint: PersistedRequestTraceEndpoint;
	failureCategory?: FailureCategory;
	httpStatus: number;
	method: "GET" | "POST";
	requestId: string;
	startedAt: Date;
}

export interface SupportService {
	lookupRequest(env: CloudflareBindings, requestId: string): Promise<SupportResult<RequestTrace>>;
	recordRequest(env: CloudflareBindings, input: RecordRequestInput): Promise<SupportResult<void>>;
}

interface RequestTraceRow {
	account_id: string;
	api_key_id: string;
	completed_at: Date | string;
	endpoint: RequestTraceEndpoint;
	failure_category: FailureCategory | null;
	http_status: number;
	method: "GET" | "POST";
	request_id: string;
	started_at: Date | string;
}

interface AttemptRow {
	account_id: string;
	api_key_id: string;
	created_at: Date | string;
	currency: string;
	estimated_input_tokens: number | string;
	id: string;
	policy_version: string;
	pricing_version: string;
	protocol: string;
	provider_attempt: number;
	provider_route: string;
	requested_model: string;
	reservation_expires_at: Date | string;
	reserved_cost_microunits: number | string;
	reserved_output_tokens: number | string;
	resolved_model: string;
}

interface LedgerRow {
	attempt_id: string;
	created_at: Date | string;
	event_type: string;
	phase: string;
	released_cost_microunits: number | string;
	released_input_tokens: number | string;
	released_output_tokens: number | string;
	reserved_cost_microunits: number | string;
	reserved_input_tokens: number | string;
	reserved_output_tokens: number | string;
	settled_cost_microunits: number | string;
	settled_input_tokens: number | string;
	settled_output_tokens: number | string;
	terminal_reason: string | null;
	usage_source: string;
}

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeInteger(value: number | string): number | undefined {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function ledgerEntry(row: LedgerRow): RequestLedgerEntry | undefined {
	const values = [
		row.released_cost_microunits,
		row.released_input_tokens,
		row.released_output_tokens,
		row.reserved_cost_microunits,
		row.reserved_input_tokens,
		row.reserved_output_tokens,
		row.settled_cost_microunits,
		row.settled_input_tokens,
		row.settled_output_tokens,
	].map(safeInteger);
	if (values.some((value) => value === undefined)) return undefined;
	return {
		createdAt: iso(row.created_at),
		eventType: row.event_type,
		phase: row.phase,
		releasedCostMicrounits: values[0] as number,
		releasedInputTokens: values[1] as number,
		releasedOutputTokens: values[2] as number,
		reservedCostMicrounits: values[3] as number,
		reservedInputTokens: values[4] as number,
		reservedOutputTokens: values[5] as number,
		settledCostMicrounits: values[6] as number,
		settledInputTokens: values[7] as number,
		settledOutputTokens: values[8] as number,
		terminalReason: row.terminal_reason,
		usageSource: row.usage_source,
	};
}

function attemptTrace(
	row: AttemptRow,
	ledger: RequestLedgerEntry[],
	pendingAttempts: Set<string>,
): RequestAttemptTrace | undefined {
	const estimatedInputTokens = safeInteger(row.estimated_input_tokens);
	const reservedOutputTokens = safeInteger(row.reserved_output_tokens);
	const reservedCostMicrounits = safeInteger(row.reserved_cost_microunits);
	if (
		estimatedInputTokens === undefined ||
		reservedOutputTokens === undefined ||
		reservedCostMicrounits === undefined ||
		!Number.isSafeInteger(row.provider_attempt) ||
		row.provider_attempt < 0
	) {
		return undefined;
	}
	return {
		accountId: row.account_id,
		apiKeyId: row.api_key_id,
		attemptId: row.id,
		createdAt: iso(row.created_at),
		currency: row.currency,
		estimatedInputTokens,
		ledger,
		pendingReservation: pendingAttempts.has(row.id),
		policyVersion: row.policy_version,
		pricingVersion: row.pricing_version,
		protocol: row.protocol,
		providerAttempt: row.provider_attempt,
		providerRoute: row.provider_route,
		requestedModel: row.requested_model,
		reservationExpiresAt: iso(row.reservation_expires_at),
		reservedCostMicrounits,
		reservedOutputTokens,
		resolvedModel: row.resolved_model,
	};
}

async function rollback(client: DatabaseClient): Promise<void> {
	await client.query("rollback").catch(() => undefined);
}

export function validRequestId(value: string): boolean {
	return REQUEST_ID_PATTERN.test(value);
}

export function createPostgresSupportService(clientFactory?: DatabaseClientFactory): SupportService {
	return {
		async recordRequest(env, input) {
			const config = getDatabaseConfig(env);
			if (!config.ok) return { message: config.message, ok: false, reason: "configuration_error" };
			if (
				!validRequestId(input.requestId) ||
				!PERSISTED_REQUEST_TRACE_ENDPOINTS.has(input.endpoint) ||
				!Number.isSafeInteger(input.httpStatus) ||
				input.httpStatus < 100 ||
				input.httpStatus > 599 ||
				input.completedAt.getTime() < input.startedAt.getTime()
			) {
				return { ok: false, reason: "unavailable" };
			}
			try {
				return await withDatabaseClient(
					config.connectionString,
					async (client): Promise<SupportResult<void>> => {
						await client.query(
							`insert into request_traces (
								request_id, account_id, api_key_id, endpoint, method, http_status,
								failure_category, started_at, completed_at
							) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
							on conflict (request_id) do nothing`,
							[
								input.requestId,
								input.accountId,
								input.apiKeyId,
								input.endpoint,
								input.method,
								input.httpStatus,
								input.failureCategory ?? null,
								input.startedAt,
								input.completedAt,
							],
						);
						return { ok: true, value: undefined };
					},
					clientFactory,
				);
			} catch {
				return { ok: false, reason: "unavailable" };
			}
		},
		async lookupRequest(env, requestId) {
			const config = getDatabaseConfig(env);
			if (!config.ok) return { message: config.message, ok: false, reason: "configuration_error" };
			try {
				return await withDatabaseClient(
					config.connectionString,
					async (client): Promise<SupportResult<RequestTrace>> => {
						await client.query("begin transaction isolation level repeatable read read only");
						try {
							const traceResult = await client.query<RequestTraceRow>(
								`select request_id, account_id, api_key_id, endpoint, method, http_status,
									failure_category, started_at, completed_at
								 from request_traces where request_id = $1`,
								[requestId],
							);
							const trace = traceResult.rows[0];
							if (!trace) {
								await client.query("commit");
								return { ok: false, reason: "not_found" };
							}
							const result = await client.query<AttemptRow>(
								`select id, request_id, provider_attempt, account_id, api_key_id, protocol, requested_model,
									resolved_model, provider_route, pricing_version, policy_version, currency,
									estimated_input_tokens, reserved_output_tokens, reserved_cost_microunits,
									reservation_expires_at, created_at
								 from usage_attempts where request_id = $1 order by provider_attempt limit $2`,
								[requestId, MAX_ATTEMPTS_PER_TRACE + 1],
							);
							const attemptRows = result.rows.slice(0, MAX_ATTEMPTS_PER_TRACE);
							const attemptIds = attemptRows.map((row) => row.id);
							const ledgerRows = attemptIds.length
								? (
										await client.query<LedgerRow>(
											`select attempt_id, phase, event_type, reserved_input_tokens, reserved_output_tokens,
										reserved_cost_microunits, released_input_tokens, released_output_tokens,
										released_cost_microunits, settled_input_tokens, settled_output_tokens,
										settled_cost_microunits, usage_source, terminal_reason, created_at
									 from usage_ledger_entries where attempt_id = any($1::uuid[])
									 order by attempt_id, created_at, id`,
											[attemptIds],
										)
									).rows
								: [];
							const pendingRows = attemptIds.length
								? (
										await client.query<{ attempt_id: string }>(
											"select attempt_id from usage_pending_reservations where attempt_id = any($1::uuid[])",
											[attemptIds],
										)
									).rows
								: [];
							const ledgerByAttempt = new Map<string, RequestLedgerEntry[]>();
							for (const row of ledgerRows) {
								const entry = ledgerEntry(row);
								if (!entry) throw new Error("invalid usage ledger amount");
								const entries = ledgerByAttempt.get(row.attempt_id) ?? [];
								entries.push(entry);
								ledgerByAttempt.set(row.attempt_id, entries);
							}
							const pendingAttempts = new Set(pendingRows.map((row) => row.attempt_id));
							const attempts = attemptRows.map((row) =>
								attemptTrace(row, ledgerByAttempt.get(row.id) ?? [], pendingAttempts),
							);
							if (attempts.some((attempt) => attempt === undefined)) {
								throw new Error("invalid usage attempt amount");
							}
							await client.query("commit");
							return {
								ok: true,
								value: {
									accountId: trace.account_id,
									apiKeyId: trace.api_key_id,
									attempts: attempts as RequestAttemptTrace[],
									completedAt: iso(trace.completed_at),
									endpoint: trace.endpoint,
									failureCategory: trace.failure_category,
									hasMore: result.rows.length > MAX_ATTEMPTS_PER_TRACE,
									httpStatus: trace.http_status,
									method: trace.method,
									requestId: trace.request_id,
									startedAt: iso(trace.started_at),
								},
							};
						} catch (error) {
							await rollback(client);
							throw error;
						}
					},
					clientFactory,
				);
			} catch {
				return { ok: false, reason: "unavailable" };
			}
		},
	};
}

export const postgresSupportService = createPostgresSupportService();
