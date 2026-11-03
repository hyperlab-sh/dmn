import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "./report.js";
import { readJudgements, score, writeSummary } from "./score.js";

const judgements = readJudgements(
	new URL("../../fixtures/replay/judgements.filled.json", import.meta.url).pathname,
);
let scratch: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-score-test-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("precision@5 of the hand-filled fixture", () => {
	expect(judgements).toHaveLength(20);
	expect(score(judgements, 5)).toEqual({ store: 0.4, activation: 0.6, judged: 20 });
});

test("unjudged entries count as not useful and are reported", () => {
	const partly = judgements.map((judgement, i) =>
		i === 2 || i === 6 ? { ...judgement, useful: null } : judgement,
	);
	// Entry 2 is a useful store hit, entry 6 a useful activation hit.
	expect(score(partly, 5)).toEqual({ store: 0.3, activation: 0.5, judged: 18 });
});

test("a list shorter than top still divides by top", () => {
	const store = judgements.filter((judgement) => judgement.order === "store");
	// Prompt 1 shows 5 (2 useful), prompt 2 only 2 (1 useful): 0.4 and 0.2, not 0.5.
	const short = [...store.slice(0, 5), ...store.slice(5, 7)];
	expect(score(short, 5).store).toBeCloseTo(0.3);
});

test("the summary says unscored, then is rewritten in place with both numbers", () => {
	const directory = join(scratch, "run");
	writeReport({ run: "run-x", top: 5, entries: [], warnings: [] }, directory);
	const path = join(directory, "report.md");

	for (const _ of [1, 2]) {
		writeSummary(directory, { ...score(judgements, 5), total: 20, top: 5 });
	}
	const report = readFileSync(path, "utf8");
	expect(report.match(/## Summary/g)).toHaveLength(1);
	expect(report).not.toContain("unscored");
	expect(report).toContain("| store | 0.40 |");
	expect(report).toContain("| activation | 0.60 |");
	expect(report).toContain("judged 20/20");
});

test("a third row appears only when activation+judge entries exist", () => {
	const third = [
		{ prompt: 1, id: "a", order: "activation+judge" as const, useful: true },
		{ prompt: 1, id: "b", order: "activation+judge" as const, useful: null },
		{ prompt: 2, id: "c", order: "activation+judge" as const, useful: true },
	];
	const result = score([...judgements, ...third], 5);
	// Two useful among prompts 1 and 2, out of top 5 each.
	expect(result.judged_order).toBeCloseTo(0.2);
	expect(result.store).toBe(0.4);
	expect(score(judgements, 5)).not.toHaveProperty("judged_order");

	const directory = join(scratch, "three");
	writeReport({ run: "run-y", top: 5, entries: [], warnings: [] }, directory);
	writeSummary(directory, { ...result, total: 23, top: 5 });
	expect(readFileSync(join(directory, "report.md"), "utf8")).toContain(
		"| activation+judge | 0.20 |",
	);
});
