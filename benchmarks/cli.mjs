import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "apps", "cli", "dist", "cli.js");
const tuiModuleUrl = pathToFileURL(join(repositoryRoot, "apps", "cli", "dist", "ui", "interactive.js")).href;

function percentile50(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = performance.now();
		const child = spawn(command, args, {
			cwd: options.cwd ?? repositoryRoot,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let firstOutputMs;
		let stdout = "";
		let stderr = "";
		const recordFirstOutput = () => {
			firstOutputMs ??= performance.now() - startedAt;
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			recordFirstOutput();
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			const elapsedMs = performance.now() - startedAt;
			if (code === 0) resolve({ elapsedMs, firstOutputMs: firstOutputMs ?? elapsedMs, stderr, stdout });
			else reject(new Error(`Benchmark child exited ${code}: ${stderr || stdout}`));
		});
	});
}

function chatChunk(delta, finishReason) {
	return {
		choices: [{ delta, finish_reason: finishReason, index: 0 }],
		created: 1_787_188_523,
		id: "chatcmpl_benchmark",
		model: "mock-resolved-fast",
		object: "chat.completion.chunk",
	};
}

function sse(response, events) {
	response.writeHead(200, { connection: "close", "content-type": "text/event-stream" });
	response.end(
		events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
	);
}

function startBenchmarkServer() {
	let requestCount = 0;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Drain the request body.
		}
		requestCount += 1;
		if (requestCount === 1) {
			setTimeout(() => {
				sse(response, [chatChunk({ content: "benchmark", role: "assistant" }, null), chatChunk({}, "stop"), "[DONE]"]);
			}, 10);
			return;
		}
		if (requestCount === 2) {
			sse(response, [
				chatChunk(
					{
						role: "assistant",
						tool_calls: [
							{
								function: { arguments: '{"command":"printf benchmark-tool > tool.txt"}', name: "bash" },
								id: "call_benchmark",
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
			return;
		}
		sse(response, [chatChunk({ content: "tool complete", role: "assistant" }, null), chatChunk({}, "stop"), "[DONE]"]);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Benchmark server did not expose a TCP address."));
				return;
			}
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				close: () =>
					new Promise((closeResolve, closeReject) => {
						server.close((error) => (error ? closeReject(error) : closeResolve()));
						server.closeAllConnections();
					}),
			});
		});
	});
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "senko-benchmark-"));
let server;
try {
	const workspace = join(temporaryRoot, "workspace");
	await mkdir(workspace);
	const coldStarts = [];
	for (let index = 0; index < 5; index += 1) {
		coldStarts.push((await run(process.execPath, [cliPath, "--help"])).elapsedMs);
	}
	const tuiReady = await run(process.execPath, [
		"--input-type=module",
		"--eval",
		`await import(${JSON.stringify(tuiModuleUrl)}); process.stdout.write("ready\\n")`,
	]);

	server = await startBenchmarkServer();
	const env = {
		...process.env,
		HOME: join(temporaryRoot, "home"),
		SENKO_BASE_URL: server.baseUrl,
		XDG_CONFIG_HOME: join(temporaryRoot, "config"),
		XDG_STATE_HOME: join(temporaryRoot, "state"),
	};
	const firstToken = await run(process.execPath, [cliPath, "--print", "benchmark ttft", "--no-session"], {
		cwd: workspace,
		env,
	});
	const toolTurnaround = await run(process.execPath, [cliPath, "--print", "benchmark tool", "--no-session"], {
		cwd: workspace,
		env,
	});

	const results = {
		cold_start_p50_ms: Number(percentile50(coldStarts).toFixed(1)),
		mock_time_to_first_token_ms: Number(firstToken.firstOutputMs.toFixed(1)),
		tool_turnaround_ms: Number(toolTurnaround.elapsedMs.toFixed(1)),
		tui_readiness_ms: Number(tuiReady.firstOutputMs.toFixed(1)),
	};
	process.stdout.write("Senko informational benchmark (not a CI gate)\n");
	process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
	await server?.close();
	await rm(temporaryRoot, { force: true, recursive: true });
}
