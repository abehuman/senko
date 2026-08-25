import { describe, expect, it } from "vitest";
import { extractProviderUsage, ProviderUsageObserver } from "../src/provider-usage";

describe("provider usage extraction", () => {
	it("extracts Chat Completions and Responses usage shapes", () => {
		expect(
			extractProviderUsage(
				{
					choices: [{ finish_reason: "stop" }],
					object: "chat.completion",
					usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
				},
				"openai-completions",
			),
		).toEqual({ inputTokens: 11, outputTokens: 7 });
		expect(
			extractProviderUsage(
				{
					object: "response",
					status: "completed",
					usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 },
				},
				"openai-responses",
			),
		).toEqual({ inputTokens: 13, outputTokens: 5 });
	});

	it("observes a terminal usage event across arbitrary chunk boundaries", () => {
		const observer = new ProviderUsageObserver("openai-responses");
		const bytes = new TextEncoder().encode(
			'event: response.completed\ndata: {"type":"response.completed","response":{"object":"response","status":"completed","usage":{"input_tokens":21,"output_tokens":8}}}\n\ndata: [DONE]\n\n',
		);
		observer.push(bytes.slice(0, 39));
		observer.push(bytes.slice(39, 77));
		observer.push(bytes.slice(77));
		expect(observer.finish()).toEqual({ inputTokens: 21, outputTokens: 8 });
	});

	it("requires a terminal Responses event instead of accepting provisional usage", () => {
		const observer = new ProviderUsageObserver("openai-responses");
		observer.push(
			new TextEncoder().encode(
				'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"object":"response","status":"in_progress","usage":{"input_tokens":21,"output_tokens":1}}}\n\n',
			),
		);
		expect(observer.finish()).toBeUndefined();
	});

	it("extracts billable usage from valid incomplete terminal events", () => {
		const observer = new ProviderUsageObserver("openai-responses");
		observer.push(
			new TextEncoder().encode(
				'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"object":"response","status":"incomplete","usage":{"input_tokens":21,"output_tokens":8}}}\n\n',
			),
		);
		expect(observer.finish()).toEqual({ inputTokens: 21, outputTokens: 8 });
	});

	it("requires a terminal Chat Completions usage chunk followed by DONE", () => {
		const terminalChunk =
			'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n';
		const completed = new ProviderUsageObserver("openai-completions");
		completed.push(new TextEncoder().encode(`${terminalChunk}data: [DONE]\n\n`));
		expect(completed.finish()).toEqual({ inputTokens: 11, outputTokens: 7 });

		const truncated = new ProviderUsageObserver("openai-completions");
		truncated.push(new TextEncoder().encode(terminalChunk));
		expect(truncated.finish()).toBeUndefined();
	});

	it("does not settle non-stream usage without a protocol terminal shape", () => {
		expect(
			extractProviderUsage(
				{ status: "in_progress", usage: { input_tokens: 13, output_tokens: 5 } },
				"openai-responses",
			),
		).toBeUndefined();
		expect(
			extractProviderUsage(
				{ choices: [{ finish_reason: null }], usage: { completion_tokens: 7, prompt_tokens: 11 } },
				"openai-completions",
			),
		).toBeUndefined();
	});

	it("ignores malformed and implausibly large usage values", () => {
		const observer = new ProviderUsageObserver("openai-completions");
		observer.push(
			new TextEncoder().encode(
				'data: not-json\n\ndata: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1000000001,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
			),
		);
		expect(observer.finish()).toBeUndefined();
	});
});
