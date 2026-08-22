import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createI18n } from "../src/i18n/index.js";
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

	it("shows only the first 14 prompt characters and modified date", () => {
		const i18n = createI18n("en");
		const items = resumeSessionItems(
			[
				session({
					firstMessage: "restore this work",
					id: "1234567890abcdef",
					messageCount: 7,
					name: "saved session name",
					modified: new Date("2026-08-21T04:05:06.000Z"),
				}),
			],
			i18n,
		);

		expect(items).toEqual([
			{
				label: "restore this w  2026-08-21",
				value: "/state/session.jsonl",
			},
		]);
	});

	it("formats the modified date in the local time zone", () => {
		const [item] = resumeSessionItems([
			session({ firstMessage: "local date", modified: new Date(2026, 7, 22, 0, 30) }),
		]);

		expect(item?.label).toBe("local date  2026-08-22");
	});

	it("counts non-ASCII prompt characters without splitting them", () => {
		const [item] = resumeSessionItems([
			session({ firstMessage: "一二三四五六七八九十一二三四五", modified: new Date(2026, 7, 22, 23, 59, 59) }),
		]);

		expect(item?.label).toBe("一二三四五六七八九十一二三四  2026-08-22");
	});

	it("renders localized CJK metadata within the terminal width", () => {
		const picker = new ResumePicker(
			[session({ firstMessage: "この作業を再開", id: "saved" })],
			{ onCancel: () => undefined, onSelect: () => undefined },
			createI18n("ja"),
		);
		const lines = picker.render(40);

		expect(lines.join("\n")).toContain("セッションを再開");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it("moves the date to a second line when the row does not fit", () => {
		const picker = new ResumePicker(
			[
				session({
					firstMessage: "一二三四五六七八九十一二三四五",
					id: "saved",
					modified: new Date(2026, 7, 22, 12),
				}),
			],
			{ onCancel: () => undefined, onSelect: () => undefined },
			createI18n("ja"),
		);
		const lines = picker.render(40);

		expect(lines).toContain("→ 一二三四五六七八九十一二三四");
		expect(lines).toContain("  2026-08-22");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	it("keeps the prompt and date on one line when they fit", () => {
		const picker = new ResumePicker(
			[session({ firstMessage: "restore this work", id: "saved", modified: new Date(2026, 7, 22, 12) })],
			{ onCancel: () => undefined, onSelect: () => undefined },
			createI18n("en"),
		);

		expect(picker.render(80)).toContain("→ restore this w  2026-08-22");
	});

	it("scrolls four-session pages in the two-line layout", () => {
		const sessions = Array.from({ length: 5 }, (_, index) =>
			session({
				firstMessage: `${index + 1}一二三四五六七八九十一二三四五`,
				id: `saved-${index}`,
				path: `/state/saved-${index}.jsonl`,
			}),
		);
		const picker = new ResumePicker(sessions, { onCancel: () => undefined, onSelect: () => undefined });

		expect(picker.render(40)).toContain("  (1/5)");
		for (let index = 0; index < 4; index += 1) picker.handleInput("\x1b[B");
		const lines = picker.render(40);

		expect(lines).toContain("  (5/5)");
		expect(lines.some((line) => line.startsWith("→ 5一二三四五六七八九十一二三"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
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
