import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? repositoryRoot,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve({ stderr, stdout });
			} else {
				reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr || stdout}`));
			}
		});
	});
}

function startMockServer() {
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Drain the request before responding.
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404, { connection: "close", "content-type": "application/json" });
			response.end('{"error":{"message":"not found","type":"not_found"}}');
			return;
		}
		const chunk = (content, finishReason) => ({
			choices: [
				{ delta: content === undefined ? {} : { content, role: "assistant" }, finish_reason: finishReason, index: 0 },
			],
			created: 1_787_188_523,
			id: "chatcmpl_package_smoke",
			model: "mock-resolved-fast",
			object: "chat.completion.chunk",
		});
		response.writeHead(200, { connection: "close", "content-type": "text/event-stream" });
		const events = [chunk("package smoke ok", null), chunk(undefined, "stop")]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("");
		response.end(`${events}data: [DONE]\n\n`);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Mock server did not expose a TCP address."));
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

const temporaryRoot = await mkdtemp(join(tmpdir(), "senko-package-smoke-"));
let mockServer;
try {
	const packDirectory = join(temporaryRoot, "pack");
	const installDirectory = join(temporaryRoot, "install");
	await mkdir(packDirectory);
	await mkdir(installDirectory);
	await writeFile(join(installDirectory, "package.json"), '{"name":"senko-package-smoke","private":true}\n');

	await run("pnpm", ["--filter", "@senkocode/cli", "pack", "--pack-destination", packDirectory]);
	const tarballs = (await readdir(packDirectory)).filter((entry) => entry.endsWith(".tgz"));
	if (tarballs.length !== 1) {
		throw new Error(`Expected one package tarball, found ${tarballs.length}.`);
	}
	const tarball = join(packDirectory, tarballs[0]);
	await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: installDirectory });

	const executable = join(installDirectory, "node_modules", ".bin", "senko");
	const executableStats = await stat(executable);
	if ((executableStats.mode & 0o111) === 0) {
		throw new Error("The installed senko executable is missing executable permissions.");
	}
	const help = await run(executable, ["--help"], { cwd: installDirectory });
	if (!help.stdout.includes("Senko — fast terminal coding agent")) {
		throw new Error("Installed package did not return Senko help text.");
	}
	const version = await run(executable, ["--version"], { cwd: installDirectory });
	const packageJson = JSON.parse(
		await readFile(join(installDirectory, "node_modules", "@senkocode", "cli", "package.json")),
	);
	if (version.stdout.trim() !== packageJson.version) {
		throw new Error(`Version output ${version.stdout.trim()} did not match package ${packageJson.version}.`);
	}

	mockServer = await startMockServer();
	const smokeEnvironment = { ...process.env };
	delete smokeEnvironment.SENKO_API_KEY;
	Object.assign(smokeEnvironment, {
		SENKO_API: "openai-completions",
		SENKO_BASE_URL: mockServer.baseUrl,
		XDG_CONFIG_HOME: join(temporaryRoot, "config"),
		XDG_STATE_HOME: join(temporaryRoot, "state"),
	});
	const printed = await run(executable, ["--print", "smoke test", "--no-session"], {
		cwd: installDirectory,
		env: smokeEnvironment,
	});
	if (printed.stdout !== "package smoke ok\n") {
		throw new Error(`Unexpected print output: ${JSON.stringify(printed.stdout)}`);
	}

	process.stdout.write(`Package smoke passed: ${tarballs[0]}\n`);
} finally {
	await mockServer?.close();
	await rm(temporaryRoot, { force: true, recursive: true });
}
