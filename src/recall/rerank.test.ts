import { describe, expect, test } from "bun:test";
import { defaultActivationParameters } from "../activation/act-r.js";
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
const stateWith = (
	counts: Record<string, number>,
	firstSeen: Record<string, string> = {},
	edges: [string, string, number][] = [],
) => ({
	associations: (id: string) =>
		edges.flatMap(([a, b, weight]) =>
			a === id ? [{ id: b, weight }] : b === id ? [{ id: a, weight }] : [],
		),
	associationFan: (id: string) => edges.filter(([a, b]) => a === id || b === id).length,
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
	// Pins the noise term of A = B + S + ε; the literal test below runs with zero noise.
	for (const m of first) expect(m.activation).toBeCloseTo(m.baseLevel + m.spreading + m.noise, 10);
	expect(first.some((m) => m.noise !== 0)).toBe(true);
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

test("an empty or unparseable createdAt falls back to firstSeenAt", () => {
	const options = { state: stateWith({}, { x: daysAgo(100) }), random: middle, now };
	const [good] = rerank([memory("x", daysAgo(100), [])], cue, new Map(), options);
	for (const createdAt of ["", "not a date"]) {
		const [ranked] = rerank([memory("x", createdAt, [])], cue, new Map(), options);
		expect(ranked?.baseLevel).toBeCloseTo(good?.baseLevel ?? Number.NaN, 10);
	}
});

describe("association", () => {
	const candidates = () => ["x", "y", "z"].map((id) => memory(id, daysAgo(5), []));
	// X is used enough to sit above the default threshold; Y and Z are equal and below it.
	const counts = { x: 40 };
	const run = (edges: [string, string, number][], parameters = defaultActivationParameters) =>
		rerank(candidates(), cue, new Map(), {
			state: stateWith(counts, {}, edges),
			parameters,
			random: middle,
			now,
		});
	const by = (ranked: ReturnType<typeof run>, id: string) =>
		ranked.find((m) => m.id === id) as ReturnType<typeof run>[number];

	test("a memory associated with a highly activated one outranks an equal one", () => {
		const ranked = run([
			["x", "y", 1],
			["x", "q", 1],
		]);
		const x = by(ranked, "x");
		expect(x.activation).toBeGreaterThan(-0.5);
		expect(ranked.map((m) => m.id)).toEqual(["x", "y", "z"]);
		// w_XY / Σ_k w_Xk = 1/2 and fan_X = 2.
		const expected =
			0.5 *
			(1 / 2) *
			Math.max(0, defaultActivationParameters.maximumAssociativeStrength - Math.log(3));
		expect(by(ranked, "y").association).toBeCloseTo(expected, 9);
		expect(by(ranked, "z").association).toBe(0);
		expect(by(ranked, "y").activation).toBeCloseTo(
			by(ranked, "y").baseLevel + by(ranked, "y").spreading + by(ranked, "y").noise + expected,
			9,
		);
	});

	test("associationWeight 0 leaves the tie-break order and no association", () => {
		const ranked = run([["x", "y", 1]], { ...defaultActivationParameters, associationWeight: 0 });
		expect(ranked.map((m) => m.id)).toEqual(["x", "y", "z"]);
		for (const m of ranked) expect(m.association).toBe(0);
		const reversed = rerank([...candidates()].reverse(), cue, new Map(), {
			state: stateWith(counts, {}, [["x", "z", 1]]),
			parameters: { ...defaultActivationParameters, associationWeight: 0 },
			random: middle,
			now,
		});
		expect(reversed.map((m) => m.id)).toEqual(["x", "z", "y"]);
	});

	test("a partner below the threshold lends nothing", () => {
		// Y is associated with Z, but neither is activated above the threshold.
		const ranked = run([["y", "z", 1]]);
		expect(by(ranked, "y").association).toBe(0);
		expect(by(ranked, "z").association).toBe(0);
	});
});
