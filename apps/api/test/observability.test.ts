import { describe, expect, it, vi } from "vitest";
import {
	buildOperationalEvent,
	emitOperationalEvent,
	OPERATIONAL_EVENT_SCHEMA_VERSION,
	type OperationalLogger,
} from "../src/observability";

describe("operational event schema", () => {
	it("rebuilds events from the versioned allowlist and drops customer or credential content", () => {
		const event = buildOperationalEvent({
			account_id: "account-internal",
			duration_ms: 12,
			event: "provider_completed",
			model: "senko/coding-model",
			outcome: "succeeded",
			provider_route: "singapore-primary",
			request_id: "req_0123456789abcdef0123456789abcdef",
			...({
				authorization: "Bearer customer-secret",
				generated_text: "private answer",
				prompt: "private prompt",
				provider_api_key: "provider-secret",
				tool_arguments: { private: true },
				tool_results: { private: true },
			} as Record<string, unknown>),
		});
		expect(event).toEqual({
			account_id: "account-internal",
			duration_ms: 12,
			event: "provider_completed",
			model: "senko/coding-model",
			outcome: "succeeded",
			provider_route: "singapore-primary",
			request_id: "req_0123456789abcdef0123456789abcdef",
			schema_version: OPERATIONAL_EVENT_SCHEMA_VERSION,
		});
		expect(JSON.stringify(event)).not.toContain("private");
		expect(JSON.stringify(event)).not.toContain("secret");
	});

	it("drops malformed strings and numbers", () => {
		const event = buildOperationalEvent({
			duration_ms: Number.POSITIVE_INFINITY,
			event: "request_finished",
			http_status: -1,
			request_id: "unsafe\nvalue",
		});
		expect(event).toEqual({ event: "request_finished", schema_version: 1 });
	});

	it("does not let logger failures affect the caller", () => {
		const logger: OperationalLogger = { emit: vi.fn(() => void 0) };
		vi.mocked(logger.emit).mockImplementation(() => {
			throw new Error("log destination unavailable");
		});
		expect(() => emitOperationalEvent(logger, { event: "request_started", outcome: "started" })).not.toThrow();
	});
});
