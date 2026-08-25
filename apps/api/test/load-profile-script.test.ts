import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/load-profile.mjs", import.meta.url);

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("API load profile script", () => {
	it("publishes the bounded source-controlled profiles without requiring a secret", async () => {
		const { stdout } = await execFileAsync(process.execPath, [script.pathname, "--help"]);
		expect(stdout).toContain("authentication | admission | streaming | settlement");
		expect(stdout).toContain("SENKO_LOAD_TEST_API_KEY");
	});

	it("validates a local dry run without sending traffic or printing a token", async () => {
		const token = "secret-that-must-not-be-printed";
		const { stdout } = await execFileAsync(
			process.execPath,
			[script.pathname, "--profile", "streaming", "--requests", "10", "--concurrency", "2", "--dry-run"],
			{ env: { ...process.env, SENKO_LOAD_TEST_API_KEY: token } },
		);
		const output = JSON.parse(stdout) as { mode: string; plan: Record<string, unknown> };
		expect(output).toMatchObject({
			mode: "dry-run",
			plan: { concurrency: 2, profile: "streaming", remote: false, requests: 10, stream: true },
		});
		expect(stdout).not.toContain(token);
	});

	it("accepts the literal separator passed by the documented pnpm invocation", async () => {
		const { stdout } = await execFileAsync(
			"pnpm",
			["--filter", "@senkocode/api", "load:profile", "--", "--profile", "settlement", "--dry-run"],
			{ cwd: new URL("../../..", import.meta.url).pathname },
		);
		const jsonStart = stdout.indexOf("{\n");
		expect(jsonStart).toBeGreaterThanOrEqual(0);
		expect(JSON.parse(stdout.slice(jsonStart))).toMatchObject({
			mode: "dry-run",
			plan: { concurrency: 2, requests: 20 },
		});
	});

	it("rejects remote traffic without both explicit confirmation gates", async () => {
		await expect(
			execFileAsync(process.execPath, [script.pathname, "--base-url", "https://staging.example.com", "--dry-run"]),
		).rejects.toMatchObject({ stderr: expect.stringContaining("Remote load testing is disabled") });
	});

	it("rejects embedded credentials and unbounded numeric overrides", async () => {
		await expect(
			execFileAsync(process.execPath, [script.pathname, "--base-url", "http://user:pass@localhost:8787", "--dry-run"]),
		).rejects.toMatchObject({ stderr: expect.stringContaining("without embedded credentials") });
		await expect(
			execFileAsync(process.execPath, [script.pathname, "--requests", "10001", "--dry-run"]),
		).rejects.toMatchObject({ stderr: expect.stringContaining("between 1 and 10000") });
	});

	it("does not follow a redirect or send the API key to its destination", async () => {
		let destinationRequests = 0;
		let destinationAuthorization: string | undefined;
		const destination = createServer((request, response) => {
			destinationRequests += 1;
			destinationAuthorization = request.headers.authorization;
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"data":[],"object":"list"}');
		});
		const destinationPort = await listen(destination);
		const redirect = createServer((_request, response) => {
			response.writeHead(307, { location: `http://127.0.0.1:${destinationPort}/captured` });
			response.end();
		});
		const redirectPort = await listen(redirect);
		try {
			await expect(
				execFileAsync(
					process.execPath,
					[script.pathname, "--base-url", `http://127.0.0.1:${redirectPort}`, "--requests", "1", "--concurrency", "1"],
					{ env: { ...process.env, SENKO_LOAD_TEST_API_KEY: "redirect-test-secret" } },
				),
			).rejects.toMatchObject({ stdout: expect.stringContaining('"transport_error": 1') });
			expect(destinationRequests).toBe(0);
			expect(destinationAuthorization).toBeUndefined();
		} finally {
			await close(redirect);
			await close(destination);
		}
	});

	it("requires both successful and contract-valid denied requests for admission evidence", async () => {
		let allDenied = false;
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			if (!allDenied && requests === 1) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
			response.end('{"error":{"code":"rate_limit_exceeded"}}');
		});
		const port = await listen(server);
		const args = [
			script.pathname,
			"--profile",
			"admission",
			"--base-url",
			`http://127.0.0.1:${port}`,
			"--requests",
			"4",
			"--concurrency",
			"4",
		];
		const options = { env: { ...process.env, SENKO_LOAD_TEST_API_KEY: "admission-test-secret" } };
		try {
			const { stdout } = await execFileAsync(process.execPath, args, options);
			expect(JSON.parse(stdout)).toMatchObject({
				criteria_failures: [],
				passed: true,
				statuses: { "200": 1, "429": 3 },
			});
			allDenied = true;
			requests = 0;
			await expect(execFileAsync(process.execPath, args, options)).rejects.toMatchObject({
				stdout: expect.stringContaining("admission_profile_requires_at_least_one_200"),
			});
		} finally {
			await close(server);
		}
	});
});
