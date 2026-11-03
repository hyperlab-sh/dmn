import { expect, test } from "bun:test";
import type { FakeKind } from "./fake.js";
import { FakeJudge } from "./fake.js";

test("probability follows keyword overlap, level scales it, counters count", async () => {
	const judge = new FakeJudge();
	const out = await judge.judge("fix the midnight rounding bug", [
		{ id: "a", text: "midnight rounding happens after the split" },
		{ id: "b", text: "deploy through preview environments" },
	]);
	expect(out.map((j) => j.id)).toEqual(["a", "b"]);
	expect(out[0]?.useful).toBeCloseTo(0.6, 10);
	expect(out[1]?.useful).toBe(0);
	expect(out[0]?.level).toBeCloseTo((out[0]?.useful ?? 0) * 3);
	expect(await judge.judge("", [{ id: "c", text: "" }])).toEqual([
		{ id: "c", useful: 0, level: 0 },
	]);
	expect({ calls: judge.calls, judged: judge.judged }).toEqual({ calls: 2, judged: 3 });
});

test("classify answers from the kind table, else turn, leaving skipped texts unanswered", async () => {
	const kinds: Record<string, FakeKind> = {
		"retries back off with jitter": { kind: "learning" },
		"we chose sqlite for the state": { kind: "decision", probability: 0.6 },
	};
	const judge = new FakeJudge({ kinds, skipTexts: ["what did we say?"] });
	expect(
		await judge.classify([
			"what did we say?",
			"retries back off with jitter",
			"we chose sqlite for the state",
			"anything else",
		]),
	).toEqual([
		{ index: 1, kind: "learning", probability: 1 },
		{ index: 2, kind: "decision", probability: 0.6 },
		{ index: 3, kind: "turn", probability: 1 },
	]);
	expect(judge.classifyCalls).toBe(1);
	expect(judge.receivedTexts).toHaveLength(4);
});
