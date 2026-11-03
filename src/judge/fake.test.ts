import { expect, test } from "bun:test";
import { FakeJudge } from "./fake.js";

test("probability follows keyword overlap, level scales it, counters count", async () => {
	const judge = new FakeJudge();
	const out = await judge.judge("fix the midnight rounding bug", [
		{ id: "a", text: "midnight rounding happens after the split" },
		{ id: "b", text: "deploy through preview environments" },
	]);
	expect(out.map((j) => j.id)).toEqual(["a", "b"]);
	expect(out[0]?.useful).toBeGreaterThan(0.3);
	expect(out[1]?.useful).toBe(0);
	expect(out[0]?.level).toBeCloseTo((out[0]?.useful ?? 0) * 3);
	expect(await judge.judge("", [{ id: "c", text: "" }])).toEqual([
		{ id: "c", useful: 0, level: 0 },
	]);
	expect({ calls: judge.calls, judged: judge.judged }).toEqual({ calls: 2, judged: 3 });
});
