import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ResumePicker, resumableSessions, resumeSessionItems } from "../src/ui/resume.js";

function session(overrides: Partial<SessionInfo>): SessionInfo {
	return {
		allMessagesText: "",
		created: new Date("2026-08-21T00:00:00.000Z"),
		cwd: "/workspace",
		firstMessage: "first prompt",
		id: "session-id",
		messageCount: 2,
		modified: new Date("2026-08-21T00:00:00.000Z"),
		path: "/state/session.jsonl",
		...overrides,
	};
}

describe("resume session picker", () => {
	it("excludes the active session and sorts saved sessions newest first", () => {
		const sessions = resumableSessions(
			[
				session({ id: "active", modified: new Date("2026-08-21T03:00:00.000Z") }),
				session({ id: "older", modified: new Date("2026-08-21T01:00:00.000Z") }),
				session({ id: "newer", modified: new Date("2026-08-21T02:00:00.000Z") }),
			],
			"active",
		);

		expect(sessions.map((saved) => saved.id)).toEqual(["newer", "older"]);
	});

	it("shows compact metadata for every saved session", () => {
		const items = resumeSessionItems([
			session({
				firstMessage: "restore this work",
				id: "1234567890abcdef",
				messageCount: 7,
				modified: new Date("2026-08-21T04:05:06.000Z"),
			}),
		]);

		expect(items).toEqual([
			expect.objectContaining({
				description: expect.stringContaining("2026-08-21 04:05:06Z · 7 messages · restore this work"),
				label: "1234567890ab",
			}),
		]);
	});

	it("selects the highlighted session with Enter", () => {
		const first = session({ id: "first", path: "/state/first.jsonl" });
		const second = session({ id: "second", path: "/state/second.jsonl" });
		let selected: SessionInfo | undefined;
		const picker = new ResumePicker([first, second], {
			onCancel: () => undefined,
			onSelect: (saved) => {
				selected = saved;
			},
		});

		picker.handleInput("\x1b[B");
		picker.handleInput("\r");

		expect(selected).toBe(second);
	});

	it("cancels with Escape without selecting a session", () => {
		let cancelled = false;
		let selected = false;
		const picker = new ResumePicker([session({ id: "saved" })], {
			onCancel: () => {
				cancelled = true;
			},
			onSelect: () => {
				selected = true;
			},
		});

		picker.handleInput("\x1b");

		expect(cancelled).toBe(true);
		expect(selected).toBe(false);
	});
});
