import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeJudge } from "../judge/fake.js";
import { judgeRun } from "./judge.js";

let directory: string;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "dmn-judge-run-"));
	const entry = (prompt: number, id: string, order: string) => ({
		prompt,
		id,
		order,
		useful: null,
	});
	writeFileSync(
		join(directory, "judgements.json"),
		JSON.stringify([
			entry(1, "a", "store"),
			entry(1, "b", "store"),
			entry(1, "a", "activation"),
			entry(2, "a", "store"),
			entry(2, "ghost", "activation"),
		]),
	);
	writeFileSync(
		join(directory, "memories.json"),
		JSON.stringify({ a: "midnight rounding split", b: "preview environments deploy" }),
	);
	writeFileSync(
		join(directory, "prompts.json"),
		JSON.stringify({ "1": "fix midnight rounding", "2": "deploy" }),
	);
	writeFileSync(
		join(directory, "report.md"),
		"### Prompt 1\n\nstore:\n1. a score=1 x\n2. b score=1 y\n\nactivation:\n1. a A=1 x\n\n### Prompt 2\n\nstore:\n1. a score=1 x\n\nactivation:\n1. ghost A=1 z\n",
	);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("judges each id once per prompt, leaves unanswered entries null, annotates idempotently", async () => {
	const judge = new FakeJudge();
	expect(await judgeRun(directory, judge, 0.5)).toEqual({ judged: 4, total: 5 });
	// Prompt 1: a and b (a shown twice); prompt 2: a only (ghost has no text).
	expect({ calls: judge.calls, judged: judge.judged }).toEqual({ calls: 2, judged: 3 });
	const entries = JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8"));
	expect(entries[0].judge).toEqual(entries[2].judge);
	expect(entries[0].useful).toBe(true);
	expect(entries[1].useful).toBe(false);
	expect(entries[4]).toEqual({ prompt: 2, id: "ghost", order: "activation", useful: null });

	await judgeRun(directory, new FakeJudge(), 0.5);
	const report = readFileSync(join(directory, "report.md"), "utf8");
	expect(report.match(/P\(useful\)/g)).toHaveLength(4);
	expect(report).toContain("1. a P(useful)=0.67 score=1 x");
	expect(report).toContain("1. ghost A=1 z");
});
