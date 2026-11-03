import { expect, test } from "bun:test";
import type { Cue } from "../cue/cue.js";
import type { MemoryUses } from "../state/state.js";
import type { MemoryRecord } from "../store/types.js";
import { rerank } from "./rerank.js";

const now = new Date("2026-06-01T00:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const cue: Cue = {
	organization: "acme",
	project: "web",
	stack: [],
	role: "developer",
	task: "test",
};
const memory = (id: string, createdAt: string, tags: string[]): MemoryRecord => ({
	id,
	text: id,
	tags,
	createdAt,
});
const stateWith = (counts: Record<string, number>, firstSeen: Record<string, string> = {}) => ({
	uses: (id: string): MemoryUses => ({
		useCount: counts[id] ?? 0,
		firstSeenAt: firstSeen[id] ?? null,
		lastUsedAt: null,
	}),
});
const middle = () => 0.5; // zero noise

test("a heavily used old memory outranks a barely used new one with the same tags", () => {
	const tags = ["project:web"];
	const ranked = rerank(
		[memory("new", daysAgo(1), tags), memory("old", daysAgo(90), tags)],
		cue,
		new Map([["project:web", 5]]),
		{ state: stateWith({ old: 40, new: 1 }), random: middle, now },
	);
	expect(ranked.map((m) => m.id)).toEqual(["old", "new"]);
});

test("a tag with a small fan outranks one with a huge fan, all else equal", () => {
	const created = daysAgo(10);
	const ranked = rerank(
		[memory("broad", created, ["role:developer"]), memory("narrow", created, ["project:web"])],
		cue,
		new Map([
			["role:developer", 3000],
			["project:web", 3],
		]),
		{ state: stateWith({}), random: middle, now },
	);
	expect(ranked.map((m) => m.id)).toEqual(["narrow", "broad"]);
	expect(ranked[0]?.spreading).toBeGreaterThan(0);
	expect(ranked[1]?.spreading).toBe(0);
});

test("the same seeded random gives the same order, and components add up", () => {
	const candidates = ["a", "b", "c", "d"].map((id) => memory(id, daysAgo(5), ["project:web"]));
	const seeded = () => {
		let seed = 42;
		return () => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return seed / 4294967296;
		};
	};
	const run = () =>
		rerank(candidates, cue, new Map(), { state: stateWith({}), random: seeded(), now });
	const first = run();
	expect(run().map((m) => m.id)).toEqual(first.map((m) => m.id));
	for (const m of first) expect(m.activation).toBeCloseTo(m.baseLevel + m.spreading + m.noise, 10);
	expect(first.some((m) => m.noise !== 0)).toBe(true);
});

test("age falls back to the state's firstSeenAt when the record has no createdAt", () => {
	const [ranked] = rerank([memory("x", "", [])], cue, new Map(), {
		state: stateWith({}, { x: daysAgo(100) }),
		random: middle,
		now,
	});
	const [fresh] = rerank([memory("y", daysAgo(0), [])], cue, new Map(), {
		state: stateWith({}),
		random: middle,
		now,
	});
	expect(ranked?.baseLevel).toBeLessThan(fresh?.baseLevel ?? 0);
});

test("components for one candidate match hand-computed values", () => {
	const [ranked] = rerank([memory("x", daysAgo(5), [])], cue, new Map(), {
		state: stateWith({}),
		random: middle,
		now,
	});
	// B = ln(1 / 0.5) - 0.5 * ln(120 hours), no shared tags, random 0.5 gives zero noise.
	expect(ranked?.baseLevel).toBeCloseTo(Math.log(2) - 0.5 * Math.log(120), 10);
	expect(ranked?.spreading).toBe(0);
	expect(ranked?.noise).toBe(0);
	expect(ranked?.activation).toBeCloseTo(ranked?.baseLevel ?? Number.NaN, 10);
});

test("an unparseable createdAt falls back to firstSeenAt", () => {
	const options = { state: stateWith({}, { x: daysAgo(100) }), random: middle, now };
	const [bad] = rerank([memory("x", "not a date", [])], cue, new Map(), options);
	const [good] = rerank([memory("x", daysAgo(100), [])], cue, new Map(), options);
	expect(bad?.baseLevel).toBeCloseTo(good?.baseLevel ?? Number.NaN, 10);
});
