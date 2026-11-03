import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryText, lastTurns, parseTranscriptLine, readTranscriptTail } from "./read.js";

const transcript = join(import.meta.dir, "../../fixtures/hooks/transcript.jsonl");

test("readTranscriptTail returns the last parseable entries and skips malformed lines", () => {
	const entries = readTranscriptTail(transcript, 3);
	expect(entries.map((entry) => entry.uuid)).toEqual(["a-2", "u-3", "a-3"]);
	expect(entries[0]?.line).toBe(3);
	expect(readTranscriptTail(transcript, 0)).toEqual([]);
	expect(readTranscriptTail(join(import.meta.dir, "missing.jsonl"), 5)).toEqual([]);
});

test("lastTurns pairs the last typed prompt with all assistant text after it", () => {
	expect(lastTurns(transcript)).toEqual({
		user: "Add jitter to the retry delay of the sync worker, please.",
		assistant: expect.stringContaining("Reading the worker first.\n\nDone. Jitter"),
		turnId: "u-2",
	});
});

test("lastTurns falls back to the line number, skips injected context and tool results", () => {
	const directory = mkdtempSync(join(tmpdir(), "dmn-transcript-"));
	try {
		const path = join(directory, "t.jsonl");
		const line = (value: object) => JSON.stringify(value);
		writeFileSync(
			path,
			[
				line({ type: "user", message: { role: "user", content: "first" } }),
				line({ type: "user", isMeta: true, message: { role: "user", content: "injected" } }),
				line({ type: "assistant", message: { role: "assistant", content: "answer" } }),
			].join("\n"),
		);
		expect(lastTurns(path)).toEqual({ user: "first", assistant: "answer", turnId: "line-0" });
		writeFileSync(path, "");
		expect(lastTurns(path)).toBeNull();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("entries read text blocks only; sidechain and message-less lines are dropped", () => {
	const entry = parseTranscriptLine(
		JSON.stringify({
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
		parseTranscriptLine(
			JSON.stringify({ isSidechain: true, message: { role: "user", content: "x" } }),
			1,
		),
	).toBeUndefined();
	expect(parseTranscriptLine(JSON.stringify({ type: "summary" }), 2)).toBeUndefined();
});
