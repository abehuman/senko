import { describe, expect, it, vi } from "vitest";
import {
	normalizedProviderSseBody,
	normalizeProviderJson,
	ProviderResponseValidationError,
	ProviderSseNormalizer,
} from "../src/provider-adapter";

const RESOLVED_MODEL = "provider/resolved-model";

function responseBody() {
	return {
		created_at: 1,
		id: "resp_test",
		metadata: { provider_internal: true },
		model: "provider/upstream-model",
		object: "response",
		output: [
			{
				content: [{ provider_debug: "secret", text: "hello", type: "output_text" }],
				id: "msg_test",
				provider_debug: "secret",
				role: "assistant",
				status: "completed",
				type: "message",
			},
		],
		status: "completed",
		usage: {
			cost: 0.01,
			input_tokens: 11,
			input_tokens_details: { cached_tokens: 3, provider_account_id: "acct_secret" },
			output_tokens: 7,
			output_tokens_details: { provider_debug: "secret", reasoning_tokens: 2 },
			provider_account_id: "acct_secret",
			total_tokens: 18,
		},
	};
}

function chatBody() {
	return {
		choices: [
			{
				finish_reason: "stop",
				index: 0,
				message: { content: "hello", role: "assistant" },
			},
		],
		created: 1,
		id: "chatcmpl_test",
		model: "provider/upstream-model",
		object: "chat.completion",
		provider_debug: "secret",
		usage: {
			completion_tokens: 7,
			completion_tokens_details: { provider_debug: "secret", reasoning_tokens: 2 },
			cost_details: { upstream: 0.01 },
			prompt_tokens: 11,
			prompt_tokens_details: { cached_tokens: 3, provider_account_id: "acct_secret" },
			total_tokens: 18,
		},
	};
}

describe("provider response adapters", () => {
	it("normalizes both non-stream protocols and strips unknown top-level fields", () => {
		const responses = normalizeProviderJson(responseBody(), "openai-responses", RESOLVED_MODEL);
		expect(responses.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
		expect(responses.body).toMatchObject({ model: RESOLVED_MODEL, object: "response", status: "completed" });
		expect(responses.body).not.toHaveProperty("metadata");
		expect(JSON.stringify(responses.body)).not.toContain("provider_debug");
		expect(JSON.stringify(responses.body)).not.toContain("provider_account_id");
		expect(JSON.stringify(responses.body)).not.toContain('"cost"');
		expect(responses.body.usage).toEqual({
			input_tokens: 11,
			input_tokens_details: { cached_tokens: 3 },
			output_tokens: 7,
			output_tokens_details: { reasoning_tokens: 2 },
			total_tokens: 18,
		});

		const chat = normalizeProviderJson(chatBody(), "openai-completions", RESOLVED_MODEL);
		expect(chat.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
		expect(chat.body).toMatchObject({ model: RESOLVED_MODEL, object: "chat.completion" });
		expect(chat.body).not.toHaveProperty("provider_debug");
		expect(JSON.stringify(chat.body)).not.toContain("provider_account_id");
		expect(JSON.stringify(chat.body)).not.toContain("cost_details");
		expect(chat.body.usage).toEqual({
			completion_tokens: 7,
			completion_tokens_details: { reasoning_tokens: 2 },
			prompt_tokens: 11,
			prompt_tokens_details: { cached_tokens: 3 },
			total_tokens: 18,
		});
	});

	it("preserves bounded reasoning and parallel function calls in both non-stream protocols", () => {
		const responses = normalizeProviderJson(
			{
				...responseBody(),
				output: [
					{
						encrypted_content: "opaque-reasoning-state",
						id: "reasoning_test",
						provider_debug: "secret",
						status: "completed",
						summary: [{ provider_debug: "secret", text: "checked constraints", type: "summary_text" }],
						type: "reasoning",
					},
					{
						arguments: '{"path":"a.ts"}',
						call_id: "call_a",
						id: "function_a",
						name: "read_file",
						provider_debug: "secret",
						status: "completed",
						type: "function_call",
					},
					{
						arguments: '{"path":"b.ts"}',
						call_id: "call_b",
						id: "function_b",
						name: "read_file",
						status: "completed",
						type: "function_call",
					},
				],
			},
			"openai-responses",
			RESOLVED_MODEL,
		);
		expect(responses.body.output).toEqual([
			{
				encrypted_content: "opaque-reasoning-state",
				id: "reasoning_test",
				status: "completed",
				summary: [{ text: "checked constraints", type: "summary_text" }],
				type: "reasoning",
			},
			{
				arguments: '{"path":"a.ts"}',
				call_id: "call_a",
				id: "function_a",
				name: "read_file",
				status: "completed",
				type: "function_call",
			},
			{
				arguments: '{"path":"b.ts"}',
				call_id: "call_b",
				id: "function_b",
				name: "read_file",
				status: "completed",
				type: "function_call",
			},
		]);

		const normalizedChat = normalizeProviderJson(
			{
				...chatBody(),
				choices: [
					{
						finish_reason: "tool_calls",
						index: 0,
						message: {
							content: null,
							provider_debug: "secret",
							reasoning_content: "checked constraints",
							role: "assistant",
							tool_calls: [
								{
									function: { arguments: '{"path":"a.ts"}', name: "read_file" },
									id: "call_a",
									type: "function",
								},
								{
									function: { arguments: '{"path":"b.ts"}', name: "read_file" },
									id: "call_b",
									type: "function",
								},
							],
						},
					},
				],
			},
			"openai-completions",
			RESOLVED_MODEL,
		);
		expect(normalizedChat.body.choices).toEqual([
			{
				finish_reason: "tool_calls",
				index: 0,
				message: {
					content: null,
					reasoning_content: "checked constraints",
					role: "assistant",
					tool_calls: [
						{
							function: { arguments: '{"path":"a.ts"}', name: "read_file" },
							id: "call_a",
							type: "function",
						},
						{
							function: { arguments: '{"path":"b.ts"}', name: "read_file" },
							id: "call_b",
							type: "function",
						},
					],
				},
			},
		]);
		expect(JSON.stringify(normalizedChat.body)).not.toContain("provider_debug");
	});

	it("accepts terminal incomplete Responses JSON and rejects nonterminal or completed bodies without usage", () => {
		const incomplete = normalizeProviderJson(
			{ ...responseBody(), incomplete_details: { reason: "max_output_tokens" }, status: "incomplete" },
			"openai-responses",
			RESOLVED_MODEL,
		);
		expect(incomplete).toMatchObject({
			terminalType: "response.incomplete",
			usage: { inputTokens: 11, outputTokens: 7 },
		});
		expect(() =>
			normalizeProviderJson({ ...responseBody(), status: "in_progress" }, "openai-responses", RESOLVED_MODEL),
		).toThrow(ProviderResponseValidationError);
		expect(() =>
			normalizeProviderJson({ ...responseBody(), usage: undefined }, "openai-responses", RESOLVED_MODEL),
		).toThrow(ProviderResponseValidationError);
		const withoutUsage = chatBody();
		delete (withoutUsage as Partial<ReturnType<typeof chatBody>>).usage;
		expect(() => normalizeProviderJson(withoutUsage, "openai-completions", RESOLVED_MODEL)).toThrow(
			ProviderResponseValidationError,
		);
	});

	it.each([
		{ choices: [chatBody().choices[0], { ...chatBody().choices[0], index: 1 }], name: "multiple choices" },
		{ choices: [{ ...chatBody().choices[0], index: 1 }], name: "a nonzero choice index" },
	])("rejects Chat JSON with $name", ({ choices }) => {
		expect(() => normalizeProviderJson({ ...chatBody(), choices }, "openai-completions", RESOLVED_MODEL)).toThrow(
			ProviderResponseValidationError,
		);
	});

	it.each([
		{
			choices: [
				{ delta: { content: "first" }, finish_reason: null, index: 0 },
				{ delta: { content: "second" }, finish_reason: null, index: 1 },
			],
			name: "multiple choices",
		},
		{ choices: [{ delta: { content: "wrong" }, finish_reason: null, index: 1 }], name: "a nonzero index" },
		{ choices: [], name: "empty choices without terminal usage" },
	])("rejects Chat SSE chunks with $name", ({ choices }) => {
		const normalizer = new ProviderSseNormalizer("openai-completions", RESOLVED_MODEL);
		expect(() =>
			normalizer.push(
				new TextEncoder().encode(
					`data: ${JSON.stringify({
						choices,
						created: 1,
						id: "chatcmpl_invalid",
						model: "provider/upstream-model",
						object: "chat.completion.chunk",
					})}\n\n`,
				),
			),
		).toThrow(ProviderResponseValidationError);
	});

	it("validates and normalizes Chat Completions SSE across arbitrary chunks", () => {
		const firstOutput = vi.fn();
		const normalizer = new ProviderSseNormalizer("openai-completions", RESOLVED_MODEL, firstOutput);
		const stream = [
			`data: ${JSON.stringify({
				choices: [{ delta: { content: "hello", role: "assistant" }, finish_reason: "stop", index: 0 }],
				created: 1,
				id: "chatcmpl_test",
				model: "provider/upstream-model",
				object: "chat.completion.chunk",
			})}\n\n`,
			`data: ${JSON.stringify({
				choices: [],
				created: 1,
				id: "chatcmpl_test",
				model: "provider/upstream-model",
				object: "chat.completion.chunk",
				usage: {
					completion_tokens: 1,
					cost: 0.01,
					prompt_tokens: 2,
					provider_account_id: "acct_secret",
					total_tokens: 3,
				},
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("");
		const bytes = new TextEncoder().encode(stream);
		const output = [
			...normalizer.push(bytes.slice(0, 17)),
			...normalizer.push(bytes.slice(17, 103)),
			...normalizer.push(bytes.slice(103)),
			...normalizer.finish(),
		];
		const text = output.map((chunk) => new TextDecoder().decode(chunk)).join("");
		expect(text).toContain(`"model":"${RESOLVED_MODEL}"`);
		expect(text).toContain("data: [DONE]");
		expect(text).not.toContain("provider/upstream-model");
		expect(text).not.toContain("provider_account_id");
		expect(text).not.toContain('"cost"');
		expect(firstOutput).toHaveBeenCalledOnce();
	});

	it("normalizes streaming parallel tool calls and reasoning events without provider extensions", () => {
		const chatFirstOutput = vi.fn();
		const chat = new ProviderSseNormalizer("openai-completions", RESOLVED_MODEL, chatFirstOutput);
		const chatStream = [
			`data: ${JSON.stringify({
				choices: [
					{
						delta: {
							provider_debug: "secret",
							tool_calls: [
								{
									function: { arguments: '{"path":"a.ts"}', name: "read_file" },
									id: "call_a",
									index: 0,
									type: "function",
								},
								{
									function: { arguments: '{"path":"b.ts"}', name: "read_file" },
									id: "call_b",
									index: 1,
									type: "function",
								},
							],
						},
						finish_reason: "tool_calls",
						index: 0,
					},
				],
				created: 1,
				id: "chatcmpl_tools",
				model: "provider/upstream-model",
				object: "chat.completion.chunk",
			})}\n\n`,
			`data: ${JSON.stringify({
				choices: [],
				created: 1,
				id: "chatcmpl_tools",
				model: "provider/upstream-model",
				object: "chat.completion.chunk",
				usage: { completion_tokens: 8, prompt_tokens: 12, total_tokens: 20 },
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("");
		const chatText = [...chat.push(new TextEncoder().encode(chatStream)), ...chat.finish()]
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");
		expect(chatText).toContain('"id":"call_a"');
		expect(chatText).toContain('"id":"call_b"');
		expect(chatText).toContain(`"model":"${RESOLVED_MODEL}"`);
		expect(chatText).not.toContain("provider_debug");
		expect(chatText).not.toContain("provider/upstream-model");
		expect(chatFirstOutput).toHaveBeenCalledOnce();

		const responsesFirstOutput = vi.fn();
		const responses = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL, responsesFirstOutput);
		const responseStream = [
			`event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
				delta: "checking",
				item_id: "reasoning_test",
				output_index: 0,
				provider_debug: "secret",
				sequence_number: 1,
				summary_index: 0,
				type: "response.reasoning_summary_text.delta",
			})}\n\n`,
			`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
				delta: '{"path":"a.ts"}',
				item_id: "function_a",
				output_index: 1,
				provider_debug: "secret",
				sequence_number: 2,
				type: "response.function_call_arguments.delta",
			})}\n\n`,
			`event: response.function_call_arguments.done\ndata: ${JSON.stringify({
				arguments: '{"path":"a.ts"}',
				item_id: "function_a",
				output_index: 1,
				sequence_number: 3,
				type: "response.function_call_arguments.done",
			})}\n\n`,
			`event: response.completed\ndata: ${JSON.stringify({
				response: responseBody(),
				sequence_number: 4,
				type: "response.completed",
			})}\n\n`,
		].join("");
		const responsesText = [...responses.push(new TextEncoder().encode(responseStream)), ...responses.finish()]
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");
		expect(responsesText).toContain('"delta":"checking"');
		expect(responsesText).toContain('"delta":"{\\"path\\":\\"a.ts\\"}"');
		expect(responsesText).toContain('"arguments":"{\\"path\\":\\"a.ts\\"}"');
		expect(responsesText).not.toContain("provider_debug");
		expect(responsesFirstOutput).toHaveBeenCalledOnce();
	});

	it("validates Responses terminal events and rejects unknown or unterminated streams", () => {
		const completed = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		const event = `event: response.completed\ndata: ${JSON.stringify({
			response: responseBody(),
			sequence_number: 1,
			type: "response.completed",
		})}\n\n`;
		const output = [...completed.push(new TextEncoder().encode(event)), ...completed.finish()];
		const text = output.map((chunk) => new TextDecoder().decode(chunk)).join("");
		expect(text).toContain(`"model":"${RESOLVED_MODEL}"`);
		expect(text).not.toContain("metadata");
		expect(text).not.toContain("provider_account_id");
		expect(text).not.toContain('"cost"');

		const unknown = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		expect(() =>
			unknown.push(new TextEncoder().encode('event: response.secret\ndata: {"type":"response.secret"}\n\n')),
		).toThrow(ProviderResponseValidationError);

		const unterminated = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		unterminated.push(
			new TextEncoder().encode(
				`event: response.in_progress\ndata: ${JSON.stringify({
					response: { ...responseBody(), status: "in_progress", usage: undefined },
					sequence_number: 1,
					type: "response.in_progress",
				})}\n\n`,
			),
		);
		expect(() => unterminated.finish()).toThrow(ProviderResponseValidationError);
	});

	it("normalizes response.queued as a nonterminal event and still requires a typed terminal event", () => {
		const queuedResponse = { ...responseBody(), output: [], status: "queued", usage: undefined };
		const queued = `event: response.queued\ndata: ${JSON.stringify({
			response: queuedResponse,
			sequence_number: 1,
			type: "response.queued",
		})}\n\n`;
		const completed = `event: response.completed\ndata: ${JSON.stringify({
			response: responseBody(),
			sequence_number: 2,
			type: "response.completed",
		})}\n\n`;

		const stream = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		const text = [...stream.push(new TextEncoder().encode(queued + completed)), ...stream.finish()]
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");
		expect(text).toContain("event: response.queued");
		expect(text).toContain('"status":"queued"');
		expect(stream.getTerminalType()).toBe("response.completed");

		const queuedOnly = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		queuedOnly.push(new TextEncoder().encode(queued));
		expect(() => queuedOnly.finish()).toThrow(ProviderResponseValidationError);
		expect(() => normalizeProviderJson(queuedResponse, "openai-responses", RESOLVED_MODEL)).toThrow(
			ProviderResponseValidationError,
		);
	});

	it("rejects the Chat [DONE] sentinel for Responses without overwriting a terminal type", () => {
		const beforeTerminal = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		expect(() => beforeTerminal.push(new TextEncoder().encode("data: [DONE]\n\n"))).toThrow(
			ProviderResponseValidationError,
		);
		expect(beforeTerminal.getTerminalType()).toBeUndefined();

		const afterTerminal = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		afterTerminal.push(
			new TextEncoder().encode(
				`event: response.completed\ndata: ${JSON.stringify({
					response: responseBody(),
					sequence_number: 1,
					type: "response.completed",
				})}\n\n`,
			),
		);
		expect(() => afterTerminal.push(new TextEncoder().encode("data: [DONE]\n\n"))).toThrow(
			ProviderResponseValidationError,
		);
		expect(afterTerminal.getTerminalType()).toBe("response.completed");
	});

	it("requires nested terminal response usage and strips unknown event fields", () => {
		const forged = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL);
		expect(() =>
			forged.push(
				new TextEncoder().encode(
					'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"object":"response","status":"completed","usage":{"input_tokens":0,"output_tokens":0}}\n\n',
				),
			),
		).toThrow(ProviderResponseValidationError);

		const firstOutput = vi.fn();
		const delta = new ProviderSseNormalizer("openai-responses", RESOLVED_MODEL, firstOutput);
		const deltaOutput = delta.push(
			new TextEncoder().encode(
				'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_test","output_index":0,"content_index":0,"delta":"ok","provider_debug":"secret","authorization":"Bearer upstream-secret"}\n\n',
			),
		);
		const deltaText = deltaOutput.map((chunk) => new TextDecoder().decode(chunk)).join("");
		expect(deltaText).toContain('"delta":"ok"');
		expect(deltaText).not.toContain("provider_debug");
		expect(deltaText).not.toContain("upstream-secret");
		expect(firstOutput).toHaveBeenCalledOnce();
	});

	it.each([
		{
			expectedTerminal: "response.completed",
			protocol: "openai-responses" as const,
			stream: () =>
				`event: response.completed\ndata: ${JSON.stringify({
					response: responseBody(),
					sequence_number: 1,
					type: "response.completed",
				})}\n\n`,
		},
		{
			expectedTerminal: "chat.completed",
			protocol: "openai-completions" as const,
			stream: () =>
				[
					`data: ${JSON.stringify({
						choices: [{ delta: { content: "ok" }, finish_reason: "stop", index: 0 }],
						created: 1,
						id: "chatcmpl_test",
						model: "provider/upstream-model",
						object: "chat.completion.chunk",
					})}\n\n`,
					`data: ${JSON.stringify({
						choices: [],
						created: 1,
						id: "chatcmpl_test",
						model: "provider/upstream-model",
						object: "chat.completion.chunk",
						usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
					})}\n\n`,
					"data: [DONE]\n\n",
				].join(""),
		},
	])("preserves $expectedTerminal when the client cancels before provider EOF", async (testCase) => {
		const onFinish = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(testCase.stream()));
			},
		});
		const body = normalizedProviderSseBody({
			body: source,
			normalizer: new ProviderSseNormalizer(testCase.protocol, RESOLVED_MODEL),
			onFinish,
		});
		const reader = body.getReader();
		expect((await reader.read()).done).toBe(false);
		await reader.cancel("terminal received");

		expect(onFinish).toHaveBeenCalledWith({
			completed: true,
			terminalErrorCode: undefined,
			terminalType: testCase.expectedTerminal,
		});
	});
});
