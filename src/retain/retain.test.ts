import { expect, test } from "bun:test";
import type { Cue } from "../cue/cue.js";
import { FakeJudge } from "../judge/fake.js";
import { FakeStore } from "../store/fake.js";
import { bankFor } from "../store/hindsight.js";
import { retainTurns } from "./retain.js";

// Built once: the cue whose soft tags every retained turn carries, and three turns — two
// retainable texts of different kinds and one that holds a secret.
const cue: Cue = {
	organization: "acme",
	project: "space",
	stack: ["bun", "typescript"],
	role: "developer",
	task: "edit",
};
const learningText = "The sync worker's retries back off with jitter, capped at five attempts.";
const decisionText = "We kept the local state in SQLite because it must work without a server.";
const secretText = "The deploy token is ghp_A0aB1cC2dD3eE4fF5gG6hH7iI8jJ9kK";
const turns = [
	{ role: "user" as const, text: learningText },
	{ role: "assistant" as const, text: decisionText },
	{ role: "user" as const, text: secretText },
];
const now = new Date("2026-02-01T00:00:00Z");

const retained = async (store: FakeStore) =>
	store.list(bankFor(cue.organization), { limit: 10, offset: 0 });

test("tags the judge's kinds in place of kind:turn after one call over the retained texts only", async () => {
	const store = new FakeStore();
	const judge = new FakeJudge({
		kinds: { [learningText]: { kind: "learning" }, [decisionText]: { kind: "decision" } },
	});
	const result = await retainTurns(store, cue, turns, { now, judge });
	expect(result).toEqual({ retained: 2, skipped: [{ role: "user", reason: "secret" }] });
	// The soft tags are unchanged; the kind tag replaces kind:turn per item.
	expect((await retained(store)).map((item) => item.tags)).toEqual([
		[
			"project:space",
			"stack:bun",
			"stack:typescript",
			"role:developer",
			"task:edit",
			"kind:learning",
		],
		[
			"project:space",
			"stack:bun",
			"stack:typescript",
			"role:developer",
			"task:edit",
			"kind:decision",
		],
	]);
	// One classify call with every text that passed shouldRetain and nothing else: the secret
	// never reaches the judge.
	expect(judge.classifyCalls).toBe(1);
	expect(judge.receivedTexts).toEqual([learningText, decisionText]);
});

test("an unanswered text, one below kindThreshold, a throwing judge and no judge keep kind:turn", async () => {
	const judge = new FakeJudge({
		kinds: { [learningText]: { kind: "learning", probability: 0.49 } },
		skipTexts: [decisionText],
	});
	const store = new FakeStore();
	const result = await retainTurns(store, cue, turns, { now, judge });
	expect(result.retained).toBe(2);
	expect((await retained(store)).map((item) => item.tags.at(-1))).toEqual([
		"kind:turn",
		"kind:turn",
	]);

	// A judge that throws costs the tags, not the retention, and warns once.
	const failing = new FakeJudge({ failWith: new Error("judge unreachable") });
	const errors: unknown[] = [];
	const down = new FakeStore();
	await retainTurns(down, cue, turns, {
		now,
		judge: failing,
		onJudgeError: (error) => errors.push(error),
	});
	expect((await retained(down)).map((item) => item.tags.at(-1))).toEqual([
		"kind:turn",
		"kind:turn",
	]);
	expect(errors).toHaveLength(1);

	// No judge at all: every turn keeps kind:turn.
	const plain = new FakeStore();
	await retainTurns(plain, cue, turns, { now });
	expect((await retained(plain)).map((item) => item.tags.at(-1))).toEqual([
		"kind:turn",
		"kind:turn",
	]);
});
