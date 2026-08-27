import process from "node:process";
import { fileURLToPath } from "node:url";

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REMOTE_CONFIRMATION = "I_UNDERSTAND_THIS_SENDS_PROVIDER_TRAFFIC";
const REQUEST_ID_PATTERN = /^req_[a-f0-9]{32}$/;
const SYNTHETIC_PROMPT = "Senko provider canary. Reply with OK.";

function usage() {
	return `Usage: pnpm --filter @senkocode/api canary:provider -- [options]

Options:
  --protocol <name>   responses | chat-completions (default: responses)
  --base-url <url>    Target root URL (default: http://127.0.0.1:8787)
  --timeout-ms <ms>   Single-request deadline (100-120000, default: 30000)
  --allow-remote      Required together with SENKO_CANARY_ALLOW_REMOTE for non-local targets
  --dry-run           Print the validated one-request plan without sending traffic
  --help              Show this help

The API key is read only from SENKO_CANARY_API_KEY. The model defaults to fast and can be
overridden with SENKO_CANARY_MODEL. Remote execution also requires:
SENKO_CANARY_ALLOW_REMOTE=${REMOTE_CONFIRMATION}`;
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

function boundedInteger(value, name, minimum, maximum) {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
	}
	return parsed;
}

export function parseProviderCanaryArguments(argv, environment = process.env) {
	const values = {
		allowRemote: false,
		baseUrl: "http://127.0.0.1:8787",
		dryRun: false,
		help: false,
		protocol: "responses",
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
			["--protocol", "protocol"],
			["--base-url", "baseUrl"],
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
	if (!new Set(["responses", "chat-completions"]).has(values.protocol)) {
		throw new Error("--protocol must be responses or chat-completions.");
	}

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
	if (remote && baseUrl.protocol !== "https:") throw new Error("Remote canary targets must use HTTPS.");
	if (remote && (!values.allowRemote || environment.SENKO_CANARY_ALLOW_REMOTE !== REMOTE_CONFIRMATION)) {
		throw new Error(
			`Remote provider canaries are disabled. Obtain approval, pass --allow-remote, and set SENKO_CANARY_ALLOW_REMOTE=${REMOTE_CONFIRMATION}.`,
		);
	}
	const model = environment.SENKO_CANARY_MODEL?.trim() || "fast";
	if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
		throw new Error("SENKO_CANARY_MODEL must be a 1-128 character model identifier.");
	}

	return {
		help: false,
		plan: {
			baseUrl: baseUrl.origin,
			dryRun: values.dryRun,
			maxOutputTokens: 8,
			model,
			path: values.protocol === "responses" ? "/v1/responses" : "/v1/chat/completions",
			protocol: values.protocol,
			remote,
			requests: 1,
			timeoutMs: boundedInteger(String(values.timeoutMs), "--timeout-ms", 100, 120_000),
		},
	};
}

async function readBoundedJson(response) {
	if (!response.body) throw new Error("response_body_missing");
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel("provider canary response exceeded client safety limit");
				throw new Error("response_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return { bytes, value: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, bytes))) };
	} catch {
		throw new Error("invalid_json_response");
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value, allowEmpty = true) {
	return typeof value === "string" && value.length <= MAX_RESPONSE_BYTES && (allowEmpty || value.length > 0);
}

function nonBlankString(value) {
	return boundedString(value, false) && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function usageFromResponse(protocol, body) {
	if (!isRecord(body)) return undefined;
	const usage = body.usage;
	if (!isRecord(usage)) return undefined;
	const inputTokens = protocol === "responses" ? usage.input_tokens : usage.prompt_tokens;
	const outputTokens = protocol === "responses" ? usage.output_tokens : usage.completion_tokens;
	if (
		!isNonNegativeInteger(inputTokens) ||
		!isNonNegativeInteger(outputTokens) ||
		!isNonNegativeInteger(usage.total_tokens)
	) {
		return undefined;
	}
	return { inputTokens, outputTokens };
}

function validChatToolCall(value) {
	return (
		isRecord(value) &&
		value.type === "function" &&
		boundedString(value.id, false) &&
		isRecord(value.function) &&
		boundedString(value.function.name, false) &&
		boundedString(value.function.arguments)
	);
}

function validChatChoice(value) {
	if (
		!isRecord(value) ||
		!isNonNegativeInteger(value.index) ||
		!boundedString(value.finish_reason, false) ||
		!isRecord(value.message) ||
		value.message.role !== "assistant" ||
		!(value.message.content === null || boundedString(value.message.content))
	) {
		return false;
	}
	if (value.message.refusal !== undefined && value.message.refusal !== null && !boundedString(value.message.refusal)) {
		return false;
	}
	if (
		value.message.reasoning_content !== undefined &&
		value.message.reasoning_content !== null &&
		!boundedString(value.message.reasoning_content)
	) {
		return false;
	}
	return (
		value.message.tool_calls === undefined ||
		(Array.isArray(value.message.tool_calls) && value.message.tool_calls.every(validChatToolCall))
	);
}

function validResponseContent(value) {
	if (!isRecord(value)) return false;
	if (value.type === "output_text") return boundedString(value.text);
	if (value.type === "refusal") return boundedString(value.refusal);
	return false;
}

function validResponseItemStatus(value) {
	return new Set(["completed", "failed", "in_progress", "incomplete"]).has(value);
}

function validResponseOutputItem(value) {
	if (!isRecord(value) || !boundedString(value.id, false) || !validResponseItemStatus(value.status)) return false;
	if (value.type === "message") {
		return value.role === "assistant" && Array.isArray(value.content) && value.content.every(validResponseContent);
	}
	if (value.type === "function_call") {
		return boundedString(value.arguments) && boundedString(value.call_id, false) && boundedString(value.name, false);
	}
	if (value.type === "reasoning") {
		if (
			!Array.isArray(value.summary) ||
			!value.summary.every(
				(summary) => isRecord(summary) && summary.type === "summary_text" && boundedString(summary.text),
			)
		) {
			return false;
		}
		return (
			value.encrypted_content === undefined ||
			value.encrypted_content === null ||
			boundedString(value.encrypted_content)
		);
	}
	return false;
}

function hasGeneratedOutput(protocol, body) {
	if (protocol === "responses") {
		return body.output.some(
			(item) =>
				item.type === "message" &&
				item.role === "assistant" &&
				item.content.some(
					(content) =>
						(content.type === "output_text" && nonBlankString(content.text)) ||
						(content.type === "refusal" && nonBlankString(content.refusal)),
				),
		);
	}
	return body.choices.some(
		(choice) => nonBlankString(choice.message.content) || nonBlankString(choice.message.refusal),
	);
}

function validateSuccessBody(plan, body) {
	if (!isRecord(body)) throw new Error("invalid_response_contract");
	if (!boundedString(body.id, false)) {
		throw new Error("invalid_response_contract");
	}
	if (!boundedString(body.model, false)) {
		throw new Error("invalid_response_contract");
	}
	if (plan.protocol === "responses") {
		if (
			body.object !== "response" ||
			body.status !== "completed" ||
			!isNonNegativeInteger(body.created_at) ||
			!Array.isArray(body.output) ||
			!body.output.every(validResponseOutputItem)
		) {
			throw new Error("invalid_response_contract");
		}
	} else if (
		body.object !== "chat.completion" ||
		!isNonNegativeInteger(body.created) ||
		!Array.isArray(body.choices) ||
		body.choices.length === 0 ||
		!body.choices.every(validChatChoice)
	) {
		throw new Error("invalid_response_contract");
	}
	const usage = usageFromResponse(plan.protocol, body);
	if (!usage) throw new Error("missing_usage");
	if (usage.outputTokens > plan.maxOutputTokens) throw new Error("output_token_limit_exceeded");
	if (!hasGeneratedOutput(plan.protocol, body)) throw new Error("empty_generated_output");
	return { model: body.model, usage };
}

export async function runProviderCanary(plan, token) {
	if (!token?.trim()) throw new Error("Set SENKO_CANARY_API_KEY before sending provider canary traffic.");
	const body =
		plan.protocol === "responses"
			? {
					input: SYNTHETIC_PROMPT,
					max_output_tokens: plan.maxOutputTokens,
					model: plan.model,
					store: false,
					stream: false,
				}
			: {
					max_completion_tokens: plan.maxOutputTokens,
					messages: [{ content: SYNTHETIC_PROMPT, role: "user" }],
					model: plan.model,
					n: 1,
					store: false,
					stream: false,
				};
	const startedAt = performance.now();
	const response = await fetch(`${plan.baseUrl}${plan.path}`, {
		body: JSON.stringify(body),
		headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" },
		method: "POST",
		redirect: "error",
		signal: AbortSignal.timeout(plan.timeoutMs),
	});
	const requestId = response.headers.get("x-request-id");
	const parsed = await readBoundedJson(response);
	if (!REQUEST_ID_PATTERN.test(requestId ?? "")) throw new Error("invalid_request_id");
	if (response.status !== 200) {
		const code =
			parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
				? parsed.value.error?.code
				: undefined;
		return {
			bytes: parsed.bytes,
			duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
			error_code: typeof code === "string" && code.length <= 64 ? code : "unknown_error",
			passed: false,
			protocol: plan.protocol,
			remote: plan.remote,
			request_id: requestId,
			status: response.status,
		};
	}
	const validated = validateSuccessBody(plan, parsed.value);
	return {
		bytes: parsed.bytes,
		duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
		input_tokens: validated.usage.inputTokens,
		model: validated.model,
		output_tokens: validated.usage.outputTokens,
		passed: true,
		protocol: plan.protocol,
		remote: plan.remote,
		request_id: requestId,
		status: response.status,
	};
}

async function main() {
	try {
		const parsed = parseProviderCanaryArguments(process.argv.slice(2));
		if (parsed.help) {
			process.stdout.write(`${usage()}\n`);
			return;
		}
		if (parsed.plan.dryRun) {
			process.stdout.write(`${JSON.stringify({ mode: "dry-run", plan: parsed.plan }, null, 2)}\n`);
			return;
		}
		const result = await runProviderCanary(parsed.plan, process.env.SENKO_CANARY_API_KEY);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.passed) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Provider canary failed."}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
