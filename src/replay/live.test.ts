import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { FakeJudge } from "../judge/fake.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import type { MemoryRecord, RecallQuery, RetainItem } from "../store/types.js";
import { orderPrompts } from "./live.js";
import { runReplay } from "./run.js";

const fixture = (name: string) =>
	new URL(`../../fixtures/replay/${name}`, import.meta.url).pathname;
const now = new Date("2026-06-03T00:00:00Z");
const config = loadConfig({
	env: { DMN_STORE_URL: "fake:", HOME: "/home/test" },
	configDir: "/nonexistent",
});

/** The texts of `live-a.jsonl` and `live-b.jsonl`, by walk position (a0 = live-a prompt 0 …). */
const texts = {
	a0u: "The widgets parser must reject trailing commas",
	a0a: "Done: the widgets parser rejects trailing commas now",
	b0u: "The widgets parser caches its grammar",
	b0a: "The widgets parser caches its grammar between runs",
	a1u: "How do I run the widgets parser tests?",
	a1a: "Run them with bun test from the package root",
	a2u: "Why does the widgets parser build fail?",
	a2a: "The build fails because the grammar fixture is stale",
	b1u: "The widgets parser build fails again",
	b1a: "Regenerate the grammar fixture and the build recovers",
};
/** Which walk position retained each text: the turns of prompt N of either file. */
const retainedAt = new Map<string, number>([
	[texts.a0u, 0],
	[texts.a0a, 0],
	[texts.b0u, 1],
	[texts.b0a, 1],
	[texts.a1u, 2],
	[texts.a1a, 2],
	[texts.a2u, 3],
	[texts.a2a, 3],
	[texts.b1u, 4],
	[texts.b1a, 4],
]);

/** A store that rejects the retain of one chosen prompt's turns and counts every call. */
class FlakyStore extends FakeStore {
	retainCalls = 0;
	private readonly failDocument: string;

	constructor(clock: () => Date, failDocument: string) {
		super(clock);
		this.failDocument = failDocument;
	}

	async retain(bank: string, items: RetainItem[]): Promise<void> {
		this.retainCalls += 1;
		if (items.some((item) => item.documentId === this.failDocument)) {
			throw new Error("hindsight 500: fact extraction refused");
		}
		await super.retain(bank, items);
	}
}

/** A store that cannot answer the recall of one chosen prompt (D40): the query is that prompt's text. */
class BlindStore extends FakeStore {
	private readonly blindSpot: string;

	constructor(clock: () => Date, blindSpot: string) {
		super(clock);
		this.blindSpot = blindSpot;
	}

	async recall(bank: string, query: RecallQuery): Promise<MemoryRecord[]> {
		if (query.query === this.blindSpot) {
			throw new Error("hindsight 504: the operation timed out");
		}
		return super.recall(bank, query);
	}
}

let scratch: string;
const states: LocalState[] = [];

// Parsed once: every walk below runs over the same ordered prompts.
const prompts = orderPrompts([fixture("live-a.jsonl"), fixture("live-b.jsonl")]);
// The two walks two tests each read: built once, reused (same inputs, same answers).
let noneWalk: Walk;
let judgedWalk: Walk;

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-live-test-"));
	noneWalk = await walk({ uses: "none" });
	judgedWalk = await walk({ uses: "judged" });
});
afterAll(() => {
	for (const state of states) state.close();
	rmSync(scratch, { recursive: true, force: true });
});

/** A deterministic stream standing in for the seeded generator. */
function counter(): () => number {
	let n = 0;
	return () => {
		n += 1;
		return (n * 0.137) % 1;
	};
}

interface Walk {
	entries: Awaited<ReturnType<typeof runReplay>>["entries"];
	live: Awaited<ReturnType<typeof runReplay>>["live"];
	bank: MemoryRecord[];
	idOf: (text: string) => string;
	uses: (text: string) => ReturnType<LocalState["uses"]>;
	associations: (text: string) => string[];
	isDormant: (text: string) => boolean;
}

/** One as-live run over the two fixtures, fresh store and state, with a walkable clock. */
async function walk(options: { uses: "judged" | "none"; measureFrom?: Date }): Promise<Walk> {
	let clockNow = now;
	const clock = {
		set: (at: Date) => {
			clockNow = at;
		},
	};
	const state = new LocalState({
		directory: join(scratch, `s${states.length}`),
		clock: () => clockNow,
	});
	states.push(state);
	const store = new FakeStore(() => clockNow);
	const result = await runReplay({
		prompts,
		store,
		state,
		config,
		top: 10,
		random: counter(),
		now,
		live: {
			uses: options.uses,
			clock,
			...(options.uses === "judged" && { judge: new FakeJudge() }),
			...(options.measureFrom !== undefined && { measureFrom: options.measureFrom }),
		},
	});
	const bank = await store.list("generic", { limit: 50, offset: 0 });
	const idOf = (text: string) => {
		const id = bank.find((record) => record.text === text)?.id;
		if (!id) throw new Error(`no memory retained with text "${text}"`);
		return id;
	};
	return {
		entries: result.entries,
		live: result.live,
		bank,
		idOf,
		uses: (text) => state.uses(idOf(text)),
		associations: (text) => state.associations(idOf(text)).map(({ id }) => id),
		isDormant: (text) => state.isDormant(idOf(text)),
	};
}

test("prompts walk interleaved in timestamp order; recall sees only what was retained before", async () => {
	const { entries } = noneWalk;
	expect(entries.map((entry) => entry.prompt.text)).toEqual([
		texts.a0u,
		texts.b0u,
		texts.a1u,
		texts.a2u,
		texts.b1u,
	]);
	// The first prompt of the day has an empty store to recall from.
	expect(entries[0]?.store).toEqual([]);
	expect(entries[0]?.activation).toEqual([]);
	// A later prompt lists memories retained from earlier prompts, of either transcript.
	const third = entries[2];
	if (!third) throw new Error("no third entry");
	const listed = (entry: NonNullable<(typeof entries)[number]>) =>
		[...entry.store, ...entry.activation].map((memory) => memory.text);
	expect(listed(third)).toEqual(
		expect.arrayContaining([texts.a0u, texts.a0a, texts.b0u, texts.b0a]),
	);
	// And no entry ever lists a memory retained from a later prompt.
	for (const [index, entry] of entries.entries()) {
		for (const text of listed(entry)) {
			expect(retainedAt.get(text), `"${text}" is not a fixture turn`).toBeLessThan(index);
		}
	}
});

test("a judged-useful memory is used at the prompt's time, and its pairs gain co-use", async () => {
	const { uses, associations, idOf } = judgedWalk;
	// The fake judge called the b0 answer useful exactly once, at the a1 prompt.
	expect(uses(texts.b0a)).toEqual({
		useCount: 1,
		firstSeenAt: "2026-01-02T10:00:00.000Z",
		lastUsedAt: "2026-01-02T10:00:00.000Z",
	});
	// Two useful in one prompt (a0's turns at the a1 prompt) hold the pair.
	expect(associations(texts.a0u)).toContain(idOf(texts.a0a));
});

test("--uses none writes no use rows and no co-use edges", async () => {
	const { uses, associations, live, bank } = await walk({ uses: "none" });
	for (const record of bank) {
		expect(uses(record.text)).toEqual({ useCount: 0, firstSeenAt: null, lastUsedAt: null });
		expect(associations(record.text)).toEqual([]);
	}
	expect(live?.uses).toBe("none");
});

test("prompts before --measure-from seed the store and are never measured", async () => {
	const { entries, live, bank, uses } = await walk({
		uses: "judged",
		measureFrom: new Date("2026-01-03T12:00:00.000Z"),
	});
	// Every prompt of both files except b1 is before the cut: four seeded, one measured.
	expect(entries.map((entry) => entry.prompt.text)).toEqual([texts.b1u]);
	expect(live).toEqual({
		uses: "judged",
		measureFrom: "2026-01-03T12:00:00.000Z",
		seeded: 4,
	});
	// Their turns are in the store, and nothing was judged: no memory has a use.
	expect(bank.map((record) => record.text)).toEqual(
		expect.arrayContaining([texts.a0u, texts.a0a, texts.a1u, texts.a1a, texts.a2u]),
	);
	for (const record of bank) expect(uses(record.text).useCount).toBe(0);
});

test("a failed retain is one warning; the walk goes on and the next prompt still recalls", async () => {
	let clockNow = now;
	const clock = { set: (at: Date) => (clockNow = at) };
	const state = new LocalState({
		directory: join(scratch, `s${states.length}`),
		clock: () => clockNow,
	});
	states.push(state);
	// The retain of live-a's second prompt (walk position 2) is rejected by the store.
	const store = new FlakyStore(() => clockNow, "live-a.jsonl:1:user");
	const result = await runReplay({
		prompts,
		store,
		state,
		config,
		top: 10,
		random: counter(),
		now,
		live: { uses: "none", clock },
	});
	// The run resolves with exactly one warning: the transcript, the prompt index, the message.
	expect(result.warnings).toEqual([
		"retain failed live-a.jsonl#1: hindsight 500: fact extraction refused",
	]);
	// The walk is otherwise unchanged: the same prompts measured, the same seeded count.
	expect(result.entries.map((entry) => entry.prompt.text)).toEqual(
		noneWalk.entries.map((entry) => entry.prompt.text),
	);
	expect(result.live?.seeded).toBe(noneWalk.live?.seeded);
	// The prompt after the failed one recalls what was retained before the failure, and never
	// the failed prompt's turns.
	const after = result.entries[3];
	if (!after) throw new Error("no entry after the failed prompt");
	const listed = [...after.store, ...after.activation].map((memory) => memory.text);
	expect(listed).toEqual(expect.arrayContaining([texts.a0u, texts.a0a, texts.b0u, texts.b0a]));
	expect(listed).not.toContain(texts.a1u);
	expect(listed).not.toContain(texts.a1a);
	// No retry: exactly one retain call per prompt.
	expect(store.retainCalls).toBe(prompts.length);
});

test("a failed recall is one warning and costs only that prompt's measurement; the walk goes on", async () => {
	let clockNow = now;
	const clock = { set: (at: Date) => (clockNow = at) };
	const state = new LocalState({
		directory: join(scratch, `s${states.length}`),
		clock: () => clockNow,
	});
	states.push(state);
	// The store cannot answer a1's recall ("How do I run the widgets parser tests?").
	const store = new BlindStore(() => clockNow, "How do I run the widgets parser tests?");
	const result = await runReplay({
		prompts,
		store,
		state,
		config,
		top: 10,
		random: counter(),
		now,
		live: { uses: "none", clock, maxConsecutiveFailures: 2 },
	});
	// The warning names the transcript, the prompt index and the message — nothing else failed.
	expect(result.warnings).toEqual([
		"recall failed live-a.jsonl#1: hindsight 504: the operation timed out",
	]);
	// a1 has no entry; every other prompt does, b1's included.
	expect(result.entries.map((entry) => entry.prompt.text)).toEqual([
		texts.a0u,
		texts.b0u,
		texts.a2u,
		texts.b1u,
	]);
	// The failed prompt's turns were still retained: the next prompt (a2, the day after)
	// recalls them.
	const after = result.entries[2];
	if (!after) throw new Error("no entry after the failed recall");
	const listed = [...after.store, ...after.activation].map((memory) => memory.text);
	expect(listed).toEqual(expect.arrayContaining([texts.a1u, texts.a1a]));
	// One failed prompt between successful ones does not stop the walk (the counter resets).
	expect(result.live?.stopped).toBeUndefined();
});

test("the sweep runs on the replayed day change: an unused day-1 memory is dormant by day 60", async () => {
	const { entries, isDormant } = judgedWalk;
	// Retained on day 1, never judged useful: dormant under the default floor.
	expect(isDormant(texts.a1a)).toBe(true);
	// A used one from the same day survives.
	expect(isDormant(texts.a0u)).toBe(false);
	// The day-60 prompt (b1) lists the survivor and not the dormant memory.
	const day60 = entries[4];
	if (!day60) throw new Error("no day-60 entry");
	const listed = [...day60.store, ...day60.activation].map((memory) => memory.text);
	expect(listed).toContain(texts.a0u);
	expect(listed).not.toContain(texts.a1a);
});
