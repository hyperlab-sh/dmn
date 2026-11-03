import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryText, lastTurns, parseTranscriptLine, readTranscriptTail } from "./read.js";

const transcript = join(import.meta.dir, "../../fixtures/hooks/transcript.jsonl");
const line = (value: object) => JSON.stringify(value);
const user = (content: unknown, extra: object = {}) =>
	line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (text: string) =>
	line({ type: "assistant", message: { role: "assistant", content: text } });

let directory: string;
const write = (name: string, lines: string[]): string => {
	const path = join(directory, name);
	writeFileSync(path, lines.join("\n"));
	return path;
};

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "dmn-transcript-"));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("readTranscriptTail returns the last parseable entries and skips malformed lines", () => {
	const entries = readTranscriptTail(transcript, 3);
	expect(entries.map((entry) => entry.uuid)).toEqual(["a-2", "u-3", "a-3"]);
	expect(readTranscriptTail(transcript, 0)).toEqual([]);
	expect(readTranscriptTail(join(directory, "missing.jsonl"), 5)).toEqual([]);
});

test("a tail longer than one chunk is read backwards with exact offsets", () => {
	const filler = "x".repeat(200);
	const lines = Array.from({ length: 3000 }, (_, index) => assistant(`${index} ${filler}`));
	const path = write("big.jsonl", lines);
	const entries = readTranscriptTail(path, 1000);
	expect(entries).toHaveLength(1000);
	expect(entryText(entries[0] as never)).toStartWith("2000 ");
	expect(entryText(entries[999] as never)).toStartWith("2999 ");
	const offset = lines.slice(0, 2000).reduce((total, text) => total + text.length + 1, 0);
	expect(entries[0]?.offset).toBe(offset);
});

test("lastTurns pairs the last typed prompt with all assistant text after it", () => {
	expect(lastTurns(transcript)).toEqual({
		user: "Add jitter to the retry delay of the sync worker, please.",
		assistant: expect.stringContaining("Reading the worker first.\n\nDone. Jitter"),
		turnId: "u-2",
	});
});

test("without a uuid the turn id is namespaced by session and offset", () => {
	const path = write("nouuid.jsonl", [user("first"), assistant("answer")]);
	expect(lastTurns(path, "session-a")).toMatchObject({ turnId: "session-a:offset-0" });
	expect(lastTurns(path, "session-b")?.turnId).not.toBe(lastTurns(path, "session-a")?.turnId);
});

test("injected context, command output, interruptions and tool results do not start a turn", () => {
	const path = write("noise.jsonl", [
		user("real prompt"),
		assistant("answer"),
		user("meta", { isMeta: true }),
		user("<local-command-stdout>ok</local-command-stdout>"),
		user("[Request interrupted by user]"),
		user([{ type: "tool_result", tool_use_id: "t", content: "x" }]),
	]);
	expect(lastTurns(path, "s")).toEqual({
		user: "real prompt",
		assistant: "answer",
		turnId: "s:offset-0",
	});
	expect(lastTurns(write("empty.jsonl", []), "s")).toBeNull();
});

test("entries read text blocks only; sidechain and message-less lines are dropped", () => {
	const entry = parseTranscriptLine(
		line({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "no" },
					{ type: "text", text: "yes" },
				],
			},
		}),
		0,
	);
	expect(entry && entryText(entry)).toBe("yes");
	expect(
		parseTranscriptLine(line({ isSidechain: true, message: { role: "user", content: "x" } }), 1),
	).toBeUndefined();
	expect(parseTranscriptLine(line({ type: "summary" }), 2)).toBeUndefined();
});
