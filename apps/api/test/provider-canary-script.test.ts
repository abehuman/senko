import { execFile } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/provider-canary.mjs", import.meta.url);

async function listen(handler: RequestListener): Promise<{ baseUrl: string; server: Server }> {
	const server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	return { baseUrl: `http://127.0.0.1:${port}`, server };
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function run(args: string[], environment: NodeJS.ProcessEnv = {}) {
	return execFileAsync(process.execPath, [script.pathname, ...args], {
		env: { ...process.env, ...environment },
	});
}

async function expectFailure(args: string[], expected: string, environment: NodeJS.ProcessEnv = {}) {
	await expect(run(args, environment)).rejects.toMatchObject({ stderr: expect.stringContaining(expected) });
}

describe("provider canary script", () => {
	it("publishes a one-request dry-run plan without requiring or printing a secret", async () => {
		const { stderr, stdout } = await run(["--dry-run"], { SENKO_CANARY_API_KEY: "must-not-appear" });

		expect(stderr).toBe("");
		expect(stdout).toContain('"requests": 1');
		expect(stdout).toContain('"maxOutputTokens": 8');
		expect(stdout).not.toContain("must-not-appear");
	});

	it("accepts the literal separator from the documented pnpm invocation", async () => {
		const { stdout } = await run(["--", "--protocol", "chat-completions", "--dry-run"]);

		expect(JSON.parse(stdout).plan).toMatchObject({
			dryRun: true,
			protocol: "chat-completions",
			requests: 1,
		});
	});

	it("rejects remote traffic without HTTPS and both confirmation gates", async () => {
		await expectFailure(["--base-url", "http://api.example.com"], "Remote canary targets must use HTTPS");
		await expectFailure(["--base-url", "https://api.example.com"], "Remote provider canaries are disabled");
		const { stdout } = await run(["--base-url", "https://api.example.com", "--allow-remote", "--dry-run"], {
			SENKO_CANARY_ALLOW_REMOTE: "I_UNDERSTAND_THIS_SENDS_PROVIDER_TRAFFIC",
		});
		expect(JSON.parse(stdout).plan).toMatchObject({ remote: true, requests: 1 });
	});

	it("rejects credentials, paths, fragments, invalid models, and unbounded deadlines", async () => {
		await expectFailure(["--base-url", "http://user:secret@localhost:8787"], "without embedded credentials");
		await expectFailure(["--base-url", "http://localhost:8787/v1"], "only the target origin");
		await expectFailure(["--base-url", "http://localhost:8787/#x"], "only the target origin");
		await expectFailure(["--timeout-ms", "120001"], "between 100 and 120000");
		await expectFailure([], "SENKO_CANARY_MODEL", { SENKO_CANARY_MODEL: "model with spaces" });
	});

	it("validates a normalized Responses result without returning generated content", async () => {
		let receivedAuthorization = "";
		const { baseUrl, server } = await listen((request, response) => {
			receivedAuthorization = request.headers.authorization ?? "";
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"a".repeat(32)}` });
			response.end(
				JSON.stringify({
					created_at: 1,
					id: "resp_canary",
					model: "provider/resolved-model",
					object: "response",
					output: [
						{
							content: [{ text: "OK", type: "output_text" }],
							id: "msg_canary",
							role: "assistant",
							status: "completed",
							type: "message",
						},
					],
					status: "completed",
					usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
				}),
			);
		});
		try {
			const { stdout } = await run(["--base-url", baseUrl], { SENKO_CANARY_API_KEY: "canary-secret" });
			const result = JSON.parse(stdout);

			expect(receivedAuthorization).toBe("Bearer canary-secret");
			expect(result).toMatchObject({
				input_tokens: 9,
				model: "provider/resolved-model",
				output_tokens: 1,
				passed: true,
				protocol: "responses",
				status: 200,
			});
			expect(stdout).not.toContain("OK");
			expect(stdout).not.toContain("canary-secret");
		} finally {
			await close(server);
		}
	});

	it("validates a normalized Chat Completions result", async () => {
		const { baseUrl, server } = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"d".repeat(32)}` });
			response.end(
				JSON.stringify({
					choices: [
						{
							finish_reason: "stop",
							index: 0,
							message: { content: "OK", role: "assistant" },
						},
					],
					created: 1,
					id: "chatcmpl_canary",
					model: "provider/resolved-model",
					object: "chat.completion",
					usage: { completion_tokens: 1, prompt_tokens: 9, total_tokens: 10 },
				}),
			);
		});
		try {
			const { stdout } = await run(["--base-url", baseUrl, "--protocol", "chat-completions"], {
				SENKO_CANARY_API_KEY: "canary-secret",
			});
			expect(JSON.parse(stdout)).toMatchObject({
				input_tokens: 9,
				output_tokens: 1,
				passed: true,
				protocol: "chat-completions",
			});
			expect(stdout).not.toContain("OK");
		} finally {
			await close(server);
		}
	});

	it("rejects redirects without sending authorization to the destination", async () => {
		let destinationRequests = 0;
		const destination = await listen((_request, response) => {
			destinationRequests += 1;
			response.end();
		});
		const origin = await listen((_request, response) => {
			response.writeHead(307, { location: `${destination.baseUrl}/stolen` });
			response.end();
		});
		try {
			await expectFailure(["--base-url", origin.baseUrl], "fetch failed", {
				SENKO_CANARY_API_KEY: "canary-secret",
			});
			expect(destinationRequests).toBe(0);
		} finally {
			await Promise.all([close(origin.server), close(destination.server)]);
		}
	});

	it("fails contract validation for missing usage and excess output tokens", async () => {
		const missingUsage = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"b".repeat(32)}` });
			response.end(
				JSON.stringify({
					created_at: 1,
					id: "resp_canary",
					model: "provider/model",
					object: "response",
					output: [],
					status: "completed",
				}),
			);
		});
		try {
			await expectFailure(["--base-url", missingUsage.baseUrl], "missing_usage", {
				SENKO_CANARY_API_KEY: "canary-secret",
			});
		} finally {
			await close(missingUsage.server);
		}

		const excessive = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"c".repeat(32)}` });
			response.end(
				JSON.stringify({
					created_at: 1,
					id: "resp_canary",
					model: "provider/model",
					object: "response",
					output: [],
					status: "completed",
					usage: { input_tokens: 9, output_tokens: 9, total_tokens: 18 },
				}),
			);
		});
		try {
			await expectFailure(["--base-url", excessive.baseUrl], "output_token_limit_exceeded", {
				SENKO_CANARY_API_KEY: "canary-secret",
			});
		} finally {
			await close(excessive.server);
		}
	});

	it("rejects null or unknown normalized output elements", async () => {
		const brokenChat = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"e".repeat(32)}` });
			response.end(
				JSON.stringify({
					choices: [null],
					created: 1,
					id: "chatcmpl_canary",
					model: "provider/model",
					object: "chat.completion",
					usage: { completion_tokens: 1, prompt_tokens: 9, total_tokens: 10 },
				}),
			);
		});
		try {
			await expectFailure(
				["--base-url", brokenChat.baseUrl, "--protocol", "chat-completions"],
				"invalid_response_contract",
				{ SENKO_CANARY_API_KEY: "canary-secret" },
			);
		} finally {
			await close(brokenChat.server);
		}

		const brokenResponse = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"f".repeat(32)}` });
			response.end(
				JSON.stringify({
					created_at: 1,
					id: "resp_canary",
					model: "provider/model",
					object: "response",
					output: [{ id: "item_unknown", status: "completed", type: "unknown" }],
					status: "completed",
					usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
				}),
			);
		});
		try {
			await expectFailure(["--base-url", brokenResponse.baseUrl], "invalid_response_contract", {
				SENKO_CANARY_API_KEY: "canary-secret",
			});
		} finally {
			await close(brokenResponse.server);
		}
	});

	it("rejects structurally valid Responses output without generated assistant text", async () => {
		const emptyResponse = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"1".repeat(32)}` });
			response.end(
				JSON.stringify({
					created_at: 1,
					id: "resp_canary",
					model: "provider/model",
					object: "response",
					output: [],
					status: "completed",
					usage: { input_tokens: 9, output_tokens: 0, total_tokens: 9 },
				}),
			);
		});
		try {
			await expectFailure(["--base-url", emptyResponse.baseUrl], "empty_generated_output", {
				SENKO_CANARY_API_KEY: "canary-secret",
			});
		} finally {
			await close(emptyResponse.server);
		}
	});

	it("rejects a Chat completion with an empty assistant message", async () => {
		const emptyChat = await listen((_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "x-request-id": `req_${"2".repeat(32)}` });
			response.end(
				JSON.stringify({
					choices: [
						{
							finish_reason: "stop",
							index: 0,
							message: { content: "  ", role: "assistant" },
						},
					],
					created: 1,
					id: "chatcmpl_canary",
					model: "provider/model",
					object: "chat.completion",
					usage: { completion_tokens: 0, prompt_tokens: 9, total_tokens: 9 },
				}),
			);
		});
		try {
			await expectFailure(
				["--base-url", emptyChat.baseUrl, "--protocol", "chat-completions"],
				"empty_generated_output",
				{ SENKO_CANARY_API_KEY: "canary-secret" },
			);
		} finally {
			await close(emptyChat.server);
		}
	});
});
