import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockProtocol = "openai-completions" | "openai-responses";
export type MockScenario = "error" | "overflow-recovery" | "preflight-compact" | "text" | "tools";

export interface RecordedRequest {
	body: Record<string, unknown>;
	headers: IncomingHttpHeaders;
	path: string;
}

export interface MockInferenceServer {
	baseUrl: string;
	close(): Promise<void>;
	requests: RecordedRequest[];
}

interface ToolStep {
	arguments: Record<string, unknown>;
	name: "bash" | "edit" | "read" | "write";
}

const TOOL_STEPS: ToolStep[] = [
	{ name: "write", arguments: { path: "artifact.txt", content: "alpha\n" } },
	{ name: "read", arguments: { path: "artifact.txt" } },
	{
		name: "edit",
		arguments: { path: "artifact.txt", edits: [{ oldText: "alpha", newText: "beta" }] },
	},
	{ name: "bash", arguments: { command: "printf 'shell-ok\\n' > shell.txt" } },
];

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		connection: "close",
		"content-type": "application/json",
		"x-request-id": "req_mock_error",
	});
	response.end(JSON.stringify(body));
}

function sendSse(response: ServerResponse, events: Array<Record<string, unknown> | "[DONE]">): void {
	response.writeHead(200, {
		"cache-control": "no-cache",
		connection: "close",
		"content-type": "text/event-stream",
		"x-request-id": "req_mock_stream",
	});
	response.end(events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join(""));
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
	return {
		choices: [{ delta, finish_reason: finishReason, index: 0 }],
		created: 1_787_188_523,
		id: "chatcmpl_mock",
		model: "mock-resolved-fast",
		object: "chat.completion.chunk",
	};
}

function sendChatText(response: ServerResponse, text: string, promptTokens = 1): void {
	const midpoint = Math.max(1, Math.floor(text.length / 2));
	sendSse(response, [
		chatChunk({ content: text.slice(0, midpoint), role: "assistant" }, null),
		chatChunk({ content: text.slice(midpoint) }, null),
		{
			...chatChunk({}, "stop"),
			usage: { completion_tokens: 1, prompt_tokens: promptTokens, total_tokens: promptTokens + 1 },
		},
		"[DONE]",
	]);
}

function sendChatTool(response: ServerResponse, step: ToolStep, index: number): void {
	const id = `call_${index + 1}`;
	sendSse(response, [
		chatChunk(
			{
				role: "assistant",
				tool_calls: [
					{
						function: { arguments: JSON.stringify(step.arguments), name: step.name },
						id,
						index: 0,
						type: "function",
					},
				],
			},
			null,
		),
		chatChunk({}, "tool_calls"),
		"[DONE]",
	]);
}

function responseEnvelope(output: Record<string, unknown>[], inputTokens = 1): Record<string, unknown> {
	return {
		created_at: 1_787_188_523,
		error: null,
		id: "resp_mock",
		incomplete_details: null,
		instructions: null,
		max_output_tokens: 4_096,
		model: "mock-resolved-fast",
		object: "response",
		output,
		parallel_tool_calls: true,
		previous_response_id: null,
		reasoning: { effort: null, summary: null },
		status: "completed",
		store: false,
		text: { format: { type: "text" } },
		tool_choice: "auto",
		tools: [],
		top_p: 1,
		truncation: "disabled",
		usage: {
			input_tokens: inputTokens,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 1,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: inputTokens + 1,
		},
	};
}

function sendResponsesText(response: ServerResponse, text: string, inputTokens = 1): void {
	const item = {
		content: [{ annotations: [], text, type: "output_text" }],
		id: "msg_mock",
		role: "assistant",
		status: "completed",
		type: "message",
	};
	const pendingItem = { ...item, content: [], status: "in_progress" };
	sendSse(response, [
		{ response: { ...responseEnvelope([], inputTokens), status: "in_progress" }, type: "response.created" },
		{ item: pendingItem, output_index: 0, type: "response.output_item.added" },
		{ content_index: 0, delta: text, item_id: "msg_mock", output_index: 0, type: "response.output_text.delta" },
		{ item, output_index: 0, type: "response.output_item.done" },
		{ response: responseEnvelope([item], inputTokens), type: "response.completed" },
	]);
}

function sendResponsesTool(response: ServerResponse, step: ToolStep, index: number): void {
	const argumentsJson = JSON.stringify(step.arguments);
	const item = {
		arguments: argumentsJson,
		call_id: `call_${index + 1}`,
		id: `fc_${index + 1}`,
		name: step.name,
		status: "completed",
		type: "function_call",
	};
	const pendingItem = { ...item, arguments: "", status: "in_progress" };
	sendSse(response, [
		{ response: { ...responseEnvelope([]), status: "in_progress" }, type: "response.created" },
		{ item: pendingItem, output_index: 0, type: "response.output_item.added" },
		{
			delta: argumentsJson,
			item_id: item.id,
			output_index: 0,
			type: "response.function_call_arguments.delta",
		},
		{
			arguments: argumentsJson,
			item_id: item.id,
			output_index: 0,
			type: "response.function_call_arguments.done",
		},
		{ item, output_index: 0, type: "response.output_item.done" },
		{ response: responseEnvelope([item]), type: "response.completed" },
	]);
}

function isCompactionRequest(body: Record<string, unknown>): boolean {
	return JSON.stringify(body).includes("structured context checkpoint summary");
}

function sendText(protocol: MockProtocol, response: ServerResponse, text: string, inputTokens = 1): void {
	if (protocol === "openai-completions") {
		sendChatText(response, text, inputTokens);
	} else {
		sendResponsesText(response, text, inputTokens);
	}
}

async function readBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const source = Buffer.concat(chunks).toString("utf8");
	return source ? (JSON.parse(source) as Record<string, unknown>) : {};
}

export async function startMockInferenceServer(options: {
	protocol: MockProtocol;
	scenario?: MockScenario;
}): Promise<MockInferenceServer> {
	const requests: RecordedRequest[] = [];
	const scenario = options.scenario ?? "text";
	let compactionRequests = 0;
	let mainRequests = 0;
	let overflowSent = false;
	const expectedPath = options.protocol === "openai-completions" ? "/v1/chat/completions" : "/v1/responses";
	const server = createServer(async (request, response) => {
		try {
			const body = await readBody(request);
			const path = new URL(request.url ?? "/", "http://localhost").pathname;
			requests.push({ body, headers: request.headers, path });
			if (request.method !== "POST" || path !== expectedPath) {
				sendJson(response, 404, { error: { message: `Unexpected ${request.method} ${path}`, type: "not_found" } });
				return;
			}
			if (scenario === "error") {
				sendJson(response, 429, {
					error: { code: "rate_limit", message: "deterministic mock failure", type: "rate_limit_error" },
				});
				return;
			}
			if (isCompactionRequest(body)) {
				compactionRequests++;
				sendText(options.protocol, response, "mock compacted summary", 1_000);
				return;
			}
			if (scenario === "preflight-compact") {
				const mainRequestIndex = mainRequests++;
				if (mainRequestIndex >= 2 && compactionRequests === 0) {
					sendJson(response, 400, {
						error: {
							code: "unsafe_preflight_request",
							message: "mock rejected a prompt that crossed the safe context threshold",
							type: "invalid_request_error",
						},
					});
					return;
				}
				sendText(options.protocol, response, "pong", mainRequestIndex === 1 ? 23_000 : 1);
				return;
			}
			if (scenario === "overflow-recovery") {
				const mainRequestIndex = mainRequests++;
				if (mainRequestIndex === 1 && !overflowSent) {
					overflowSent = true;
					sendJson(response, 400, {
						error: {
							code: "context_length_exceeded",
							message: "This model's maximum context length is 32768 tokens.",
							type: "invalid_request_error",
						},
					});
					return;
				}
				if (mainRequestIndex >= 2 && compactionRequests !== 1) {
					sendJson(response, 500, {
						error: {
							message: "mock expected exactly one compaction before overflow retry",
							type: "mock_server_error",
						},
					});
					return;
				}
				sendText(options.protocol, response, "pong", 1);
				return;
			}

			const requestIndex = requests.length - 1;
			const step = scenario === "tools" ? TOOL_STEPS[requestIndex] : undefined;
			if (options.protocol === "openai-completions") {
				if (step) sendChatTool(response, step, requestIndex);
				else sendChatText(response, scenario === "tools" ? "tools complete" : "pong");
			} else if (step) {
				sendResponsesTool(response, step, requestIndex);
			} else {
				sendResponsesText(response, scenario === "tools" ? "tools complete" : "pong");
			}
		} catch (error) {
			sendJson(response, 500, {
				error: { message: error instanceof Error ? error.message : String(error), type: "mock_server_error" },
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
		requests,
	};
}
