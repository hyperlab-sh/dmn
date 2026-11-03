import { expect, test } from "bun:test";
import type { Cue } from "../cue/cue.js";
import { FakeJudge } from "../judge/fake.js";
import { JudgeError, type KindJudge } from "../judge/types.js";
import { FakeStore } from "../store/fake.js";
import { bankFor } from "../store/hindsight.js";
import { retainTurns } from "./retain.js";

// Built once: the cue whose soft tags every retained turn carries, and four turns — three
// retainable texts (a learning, a decision, one that will rate below the bar) and a secret.
const cue: Cue = {
	organization: "acme",
	project: "space",
	stack: ["bun", "typescript"],
	role: "developer",
	task: "edit",
};
const learningText = "The sync worker's retries back off with jitter, capped at five attempts.";
const decisionText = "We kept the local state in SQLite because it must work without a server.";
const lowText = "The build box reboots every night at three.";
const secretText = "The deploy token is ghp_A0aB1cC2dD3eE4fF5gG6hH7iI8jJ9kK";
const turns = [
	{ role: "user" as const, text: learningText },
	{ role: "assistant" as const, text: decisionText },
	{ role: "user" as const, text: lowText },
	{ role: "assistant" as const, text: secretText },
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
	expect(result).toEqual({ retained: 3, skipped: [{ role: "assistant", reason: "secret" }] });
	// The soft tags are unchanged; the kind tag replaces kind:turn per item (lowText answers turn).
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
		["project:space", "stack:bun", "stack:typescript", "role:developer", "task:edit", "kind:turn"],
	]);
	// One classify call with every text that passed shouldRetain and nothing else: the secret
	// never reaches the judge.
	expect(judge.classifyCalls).toBe(1);
	expect(judge.receivedTexts).toEqual([learningText, decisionText, lowText]);
});

test("kinds follow classification.index: the first text unanswered, a later one at the bar", async () => {
	const judge = new FakeJudge({
		kinds: {
			// Exactly the default threshold: at or above it, the kind stands.
			[decisionText]: { kind: "decision", probability: 0.5 },
			[lowText]: { kind: "learning", probability: 0.49 },
		},
		skipTexts: [learningText],
	});
	const store = new FakeStore();
	const result = await retainTurns(store, cue, turns, { now, judge });
	expect(result.retained).toBe(3);
	// learningText is unanswered and lowText is below the bar: both keep kind:turn, and the
	// decision lands on decisionText's own slot, not on the first position.
	expect((await retained(store)).map((item) => item.tags.at(-1))).toEqual([
		"kind:turn",
		"kind:decision",
		"kind:turn",
	]);
});

test("a judge that throws, or none at all, keeps kind:turn with one warning", async () => {
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
		"kind:turn",
	]);
	expect(errors).toHaveLength(1);

	const plain = new FakeStore();
	await retainTurns(plain, cue, turns, { now });
	expect((await retained(plain)).map((item) => item.tags.at(-1))).toEqual([
		"kind:turn",
		"kind:turn",
		"kind:turn",
	]);
});

test("a classify call that outlives its deadline costs the tags, not the retention", async () => {
	const hanging: KindJudge = { classify: () => new Promise(() => {}) };
	const errors: unknown[] = [];
	const store = new FakeStore();
	const result = await retainTurns(store, cue, turns, {
		now,
		judge: hanging,
		judgeDeadlineMs: 5,
		// The deadline fires at once: no real timer, no sleep.
		sleep: () => Promise.resolve(),
		onJudgeError: (error) => errors.push(error),
	});
	expect(result.retained).toBe(3);
	expect((await retained(store)).map((item) => item.tags.at(-1))).toEqual([
		"kind:turn",
		"kind:turn",
		"kind:turn",
	]);
	expect(errors).toHaveLength(1);
	expect(errors[0]).toBeInstanceOf(JudgeError);
	expect((errors[0] as Error).message).toContain("deadline");
});

test("every retained item carries the content time: timestamp is now, not the ingest clock", async () => {
	const clock = new Date("2026-02-01T00:00:00Z");
	const store = new FakeStore(() => new Date("2020-01-01T00:00:00Z"));
	await retainTurns(store, cue, [turns[0] ?? { role: "user", text: learningText }], { now: clock });
	const items = await retained(store);
	expect(items).toHaveLength(1);
	// The wire item's timestamp is the given now; a store that honours it backdates the memory
	// instead of stamping it at its own clock.
	expect(items[0]?.createdAt).toBe("2026-02-01T00:00:00.000Z");
});
