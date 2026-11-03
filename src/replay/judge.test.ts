import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeJudge } from "../judge/fake.js";
import type { Judge } from "../judge/types.js";
import { judgeRun } from "./judge.js";

let directory: string;

const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));

beforeEach(() => {
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
			entry(3, "a", "store"),
			entry(4, "leaky", "store"),
		]),
	);
	writeFileSync(
		join(directory, "memories.json"),
		JSON.stringify({
			a: "midnight rounding split",
			b: "preview environments deploy",
			leaky: "set api_key=abcdef123456 before deploy",
		}),
	);
	// Prompt 3 held a secret, so the run never wrote its text.
	writeFileSync(
		join(directory, "prompts.json"),
		JSON.stringify({ "1": "fix midnight rounding", "2": "deploy", "4": "deploy" }),
	);
	writeFileSync(
		join(directory, "report.md"),
		"### Prompt 1\n\nstore:\n1. a score=1 x\n2. b score=1 y\n\nactivation:\n1. a A=1 x\n\n### Prompt 2\n\nstore:\n1. a score=1 x\n\nactivation:\n1. ghost A=1 z\n",
	);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

// The small half of the replay judge row: dedupe, reuse, secrets and the report lines.
test("judges each id once per prompt, never a secret, and annotates idempotently", async () => {
	const judge = new FakeJudge();
	expect(await judgeRun(directory, judge, 0.5)).toEqual({ judged: 4, total: 7 });
	// Prompt 1: a and b (a shown twice); prompt 2: a. Prompt 3 has no text; 4's memory is a secret.
	expect({ calls: judge.calls, judged: judge.judged }).toEqual({ calls: 2, judged: 3 });
	const entries = read("judgements.json");
	expect(entries[0].judge).toEqual(entries[2].judge);
	expect(entries[0].useful).toBe(true);
	expect(entries[1].useful).toBe(false);
	for (const index of [4, 5, 6]) expect(entries[index].useful).toBeNull();

	await judgeRun(directory, new FakeJudge(), 0.5);
	const report = readFileSync(join(directory, "report.md"), "utf8");
	expect(report.match(/P\(useful\)/g)).toHaveLength(4);
	expect(report).toContain("1. a P(useful)=0.67 score=1 x");
	expect(report).toContain("1. ghost A=1 z");
});

test("a prompt holding a secret is never sent", async () => {
	writeFileSync(
		join(directory, "prompts.json"),
		JSON.stringify({ "1": "use api_key=abcdef123456 to fix midnight rounding" }),
	);
	const judge = new FakeJudge();
	await judgeRun(directory, judge, 0.5);
	expect(judge.calls).toBe(0);
	expect(read("judgements.json").every((e: { useful: unknown }) => e.useful === null)).toBe(true);
});

test("a new threshold reuses stored answers: no calls, useful flips", async () => {
	await judgeRun(directory, new FakeJudge(), 0.5);
	const second = new FakeJudge();
	expect(await judgeRun(directory, second, 0.7)).toEqual({ judged: 4, total: 7 });
	expect(second.calls).toBe(0);
	// a scored 0.67 for prompt 1: useful at 0.5, not at 0.7.
	expect(read("judgements.json").map((e: { useful: unknown }) => e.useful)).toEqual([
		false,
		false,
		false,
		false,
		null,
		null,
		null,
	]);
});

test("a judge failure keeps what was answered and a re-run resumes", async () => {
	let calls = 0;
	let onDisk = -1;
	const flaky: Judge = {
		async judge(prompt, memories) {
			calls += 1;
			// A run killed here must already have prompt 1 on disk.
			if (calls === 2) {
				onDisk = read("judgements.json").filter((e: { judge?: unknown }) => e.judge).length;
				throw new Error("402 out of credit");
			}
			return new FakeJudge().judge(prompt, memories);
		},
	};
	const first = await judgeRun(directory, flaky, 0.5);
	expect(first.judged).toBe(3);
	expect(onDisk).toBe(3);
	expect(first.error?.message).toBe("402 out of credit");
	const resumed = new FakeJudge();
	expect(await judgeRun(directory, resumed, 0.5)).toEqual({ judged: 4, total: 7 });
	expect(resumed.judged).toBe(1);
});

test("a prompt the service only partly answered does not stop the run", async () => {
	const partial: Judge = {
		async judge(prompt, memories) {
			const all = await new FakeJudge().judge(prompt, memories);
			// Prompt 1 asks about a and b; the service refuses b.
			return all.filter((judgement) => judgement.id !== "b");
		},
	};
	expect(await judgeRun(directory, partial, 0.5)).toEqual({ judged: 3, total: 7 });
	const entries = read("judgements.json");
	expect(entries[1].judge).toBeUndefined();
	expect(entries[1].useful).toBeNull();
	// Prompt 2 was still judged after prompt 1 came back short.
	expect(entries[3].judge).toBeDefined();
});
