import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_RESPONSE_BYTES = 9 * 1024 * 1024;
const MAX_ERROR_PREVIEW_BYTES = 64 * 1024;
const REMOTE_CONFIRMATION = "I_UNDERSTAND_THIS_SENDS_TRAFFIC";
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export const LOAD_PROFILES = Object.freeze({
	authentication: Object.freeze({
		acceptedStatuses: Object.freeze([200]),
		concurrency: 20,
		method: "GET",
		path: "/v1/models",
		requests: 200,
	}),
	admission: Object.freeze({
		acceptedStatuses: Object.freeze([200, 429]),
		concurrency: 12,
		method: "POST",
		path: "/v1/responses",
		requests: 24,
		requiresAdmissionEvidence: true,
		stream: false,
	}),
	streaming: Object.freeze({
		acceptedStatuses: Object.freeze([200]),
		concurrency: 2,
		method: "POST",
		path: "/v1/responses",
		requests: 10,
		stream: true,
	}),
	settlement: Object.freeze({
		acceptedStatuses: Object.freeze([200]),
		concurrency: 2,
		method: "POST",
		path: "/v1/responses",
		requests: 20,
		stream: false,
	}),
});

function usage() {
	return `Usage: pnpm --filter @senkocode/api load:profile -- [options]

Options:
  --profile <name>       authentication | admission | streaming | settlement
  --base-url <url>       Target root URL (default: http://127.0.0.1:8787)
  --requests <count>     Override request count (1-10000)
  --concurrency <count>  Override concurrency (1-200, no greater than requests)
  --timeout-ms <ms>      Per-request deadline (100-300000, default: 30000)
  --allow-remote         Required together with SENKO_LOAD_TEST_ALLOW_REMOTE for non-local targets
  --dry-run              Print the validated plan without sending traffic
  --help                 Show this help

Secrets are read only from SENKO_LOAD_TEST_API_KEY. The model defaults to fast and can be
overridden with SENKO_LOAD_TEST_MODEL. Remote execution also requires:
SENKO_LOAD_TEST_ALLOW_REMOTE=${REMOTE_CONFIRMATION}`;
}

function optionValue(argv, index, name) {
	const argument = argv[index];
	if (argument === name) {
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
		return { consumed: 2, value };
	}
	if (argument.startsWith(`${name}=`)) {
		const value = argument.slice(name.length + 1);
		if (!value) throw new Error(`${name} requires a value.`);
		return { consumed: 1, value };
	}
	return undefined;
}

function positiveInteger(value, name, maximum, minimum = 1) {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
	}
	return parsed;
}

export function parseLoadProfileArguments(argv, environment = process.env) {
	const values = {
		allowRemote: false,
		baseUrl: "http://127.0.0.1:8787",
		concurrency: undefined,
		dryRun: false,
		help: false,
		profile: "authentication",
		requests: undefined,
		timeoutMs: 30_000,
	};
	for (let index = 0; index < argv.length; ) {
		const argument = argv[index];
		if (index === 0 && argument === "--") {
			index += 1;
			continue;
		}
		if (argument === "--allow-remote") {
			values.allowRemote = true;
			index += 1;
			continue;
		}
		if (argument === "--dry-run") {
			values.dryRun = true;
			index += 1;
			continue;
		}
		if (argument === "--help") {
			values.help = true;
			index += 1;
			continue;
		}
		let matched = false;
		for (const [name, field] of [
			["--profile", "profile"],
			["--base-url", "baseUrl"],
			["--requests", "requests"],
			["--concurrency", "concurrency"],
			["--timeout-ms", "timeoutMs"],
		]) {
			const option = optionValue(argv, index, name);
			if (!option) continue;
			values[field] = option.value;
			index += option.consumed;
			matched = true;
			break;
		}
		if (!matched) throw new Error(`Unsupported option: ${argument}`);
	}
	if (values.help) return { help: true };

	const profile = LOAD_PROFILES[values.profile];
	if (!profile) throw new Error(`Unknown profile: ${values.profile}`);
	const requests =
		values.requests === undefined ? profile.requests : positiveInteger(String(values.requests), "--requests", 10_000);
	const concurrency =
		values.concurrency === undefined
			? profile.concurrency
			: positiveInteger(String(values.concurrency), "--concurrency", 200);
	const timeoutMs = positiveInteger(String(values.timeoutMs), "--timeout-ms", 300_000, 100);
	if (concurrency > requests) throw new Error("--concurrency cannot exceed --requests.");

	let baseUrl;
	try {
		baseUrl = new URL(values.baseUrl);
	} catch {
		throw new Error("--base-url must be an absolute HTTP(S) URL.");
	}
	if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
		throw new Error("--base-url must be an HTTP(S) URL without embedded credentials.");
	}
	if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
		throw new Error("--base-url must contain only the target origin, without a path, query, or fragment.");
	}
	const remote = !LOCAL_HOSTS.has(baseUrl.hostname.toLowerCase());
	if (remote && baseUrl.protocol !== "https:") throw new Error("Remote load targets must use HTTPS.");
	if (remote && (!values.allowRemote || environment.SENKO_LOAD_TEST_ALLOW_REMOTE !== REMOTE_CONFIRMATION)) {
		throw new Error(
			`Remote load testing is disabled. Obtain approval, pass --allow-remote, and set SENKO_LOAD_TEST_ALLOW_REMOTE=${REMOTE_CONFIRMATION}.`,
		);
	}

	return {
		help: false,
		plan: {
			acceptedStatuses: [...profile.acceptedStatuses],
			baseUrl: baseUrl.origin,
			concurrency,
			dryRun: values.dryRun,
			method: profile.method,
			model: environment.SENKO_LOAD_TEST_MODEL?.trim() || "fast",
			path: profile.path,
			profile: values.profile,
			remote,
			requiresAdmissionEvidence: profile.requiresAdmissionEvidence === true,
			requests,
			stream: profile.stream === true,
			timeoutMs,
		},
	};
}

async function consumeBoundedBody(response, captureErrorPreview) {
	if (!response.body) return { bytes: 0, errorPreview: "" };
	const reader = response.body.getReader();
	let bytes = 0;
	let previewBytes = 0;
	const previewChunks = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				return {
					bytes,
					errorPreview: captureErrorPreview ? new TextDecoder().decode(Buffer.concat(previewChunks, previewBytes)) : "",
				};
			}
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel("load profile response exceeded client safety limit");
				throw new Error("response_too_large");
			}
			if (captureErrorPreview && previewBytes < MAX_ERROR_PREVIEW_BYTES) {
				const remaining = MAX_ERROR_PREVIEW_BYTES - previewBytes;
				const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
				previewChunks.push(chunk);
				previewBytes += chunk.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function executeRequest(plan, token) {
	const startedAt = performance.now();
	try {
		const headers = { authorization: `Bearer ${token}` };
		let body;
		if (plan.method === "POST") {
			headers["content-type"] = "application/json";
			body = JSON.stringify({
				input: "Senko synthetic load verification. Reply with OK.",
				max_output_tokens: 8,
				model: plan.model,
				store: false,
				stream: plan.stream,
			});
		}
		const response = await fetch(`${plan.baseUrl}${plan.path}`, {
			body,
			headers,
			method: plan.method,
			redirect: "error",
			signal: AbortSignal.timeout(plan.timeoutMs),
		});
		const consumed = await consumeBoundedBody(response, response.status === 429);
		let rateLimitCode;
		if (response.status === 429) {
			try {
				const parsed = JSON.parse(consumed.errorPreview);
				rateLimitCode = parsed?.error?.code;
			} catch {
				rateLimitCode = undefined;
			}
		}
		return {
			bytes: consumed.bytes,
			durationMs: performance.now() - startedAt,
			rateLimitCode,
			retryAfterValid: response.status !== 429 || /^\d+$/.test(response.headers.get("retry-after") ?? ""),
			status: response.status,
		};
	} catch (error) {
		return {
			bytes: 0,
			durationMs: performance.now() - startedAt,
			error:
				error instanceof Error && error.message === "response_too_large" ? "response_too_large" : "transport_error",
			status: null,
		};
	}
}

function percentile(sorted, fraction) {
	if (sorted.length === 0) return null;
	return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100;
}

export async function runLoadProfile(plan, token) {
	if (!token?.trim()) throw new Error("Set SENKO_LOAD_TEST_API_KEY before sending load traffic.");
	let nextRequest = 0;
	const results = [];
	const startedAt = performance.now();
	const worker = async () => {
		for (;;) {
			const requestIndex = nextRequest;
			nextRequest += 1;
			if (requestIndex >= plan.requests) return;
			results[requestIndex] = await executeRequest(plan, token.trim());
		}
	};
	await Promise.all(Array.from({ length: plan.concurrency }, worker));
	const durationMs = performance.now() - startedAt;
	const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
	const statuses = {};
	const errors = {};
	const durationsByOutcome = {};
	let expected = 0;
	let invalidRateLimitResponses = 0;
	let responseBytes = 0;
	for (const result of results) {
		responseBytes += result.bytes;
		if (result.status !== null) {
			statuses[String(result.status)] = (statuses[String(result.status)] ?? 0) + 1;
			durationsByOutcome[String(result.status)] ??= [];
			durationsByOutcome[String(result.status)].push(result.durationMs);
			if (plan.acceptedStatuses.includes(result.status)) expected += 1;
			if (result.status === 429 && (result.rateLimitCode !== "rate_limit_exceeded" || !result.retryAfterValid)) {
				invalidRateLimitResponses += 1;
			}
		} else {
			errors[result.error] = (errors[result.error] ?? 0) + 1;
			durationsByOutcome[result.error] ??= [];
			durationsByOutcome[result.error].push(result.durationMs);
		}
	}
	const criteriaFailures = [];
	if (plan.requiresAdmissionEvidence) {
		if (!statuses["200"]) criteriaFailures.push("admission_profile_requires_at_least_one_200");
		if (!statuses["429"]) criteriaFailures.push("admission_profile_requires_at_least_one_429");
		if (invalidRateLimitResponses > 0) criteriaFailures.push("invalid_rate_limit_response_contract");
	}
	const latencyByOutcome = {};
	for (const [outcome, outcomeDurations] of Object.entries(durationsByOutcome)) {
		outcomeDurations.sort((left, right) => left - right);
		latencyByOutcome[outcome] = {
			p50: percentile(outcomeDurations, 0.5),
			p95: percentile(outcomeDurations, 0.95),
			p99: percentile(outcomeDurations, 0.99),
		};
	}
	const unexpected = plan.requests - expected;
	return {
		concurrency: plan.concurrency,
		criteria_failures: criteriaFailures,
		duration_ms: Math.round(durationMs * 100) / 100,
		errors,
		expected_statuses: expected,
		latency_ms: {
			p50: percentile(durations, 0.5),
			p95: percentile(durations, 0.95),
			p99: percentile(durations, 0.99),
		},
		latency_ms_by_outcome: latencyByOutcome,
		passed: unexpected === 0 && criteriaFailures.length === 0,
		profile: plan.profile,
		remote: plan.remote,
		requests: plan.requests,
		response_bytes: responseBytes,
		statuses,
		throughput_rps: durationMs > 0 ? Math.round((plan.requests / durationMs) * 100_000) / 100 : null,
		unexpected,
	};
}

async function main() {
	try {
		const parsed = parseLoadProfileArguments(process.argv.slice(2));
		if (parsed.help) {
			process.stdout.write(`${usage()}\n`);
			return;
		}
		if (parsed.plan.dryRun) {
			process.stdout.write(`${JSON.stringify({ mode: "dry-run", plan: parsed.plan }, null, 2)}\n`);
			return;
		}
		const result = await runLoadProfile(parsed.plan, process.env.SENKO_LOAD_TEST_API_KEY);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.passed) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Load profile failed."}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
