import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { recall } from "../recall/pipeline.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import type { ListQuery, MemoryStore } from "../store/types.js";
import { sweep } from "./sweep.js";

const now = new Date("2026-06-01T00:00:00Z");
const day = 86_400_000;
const bank = "generic";

let scratch: string;
let state: LocalState;
let pagedState: LocalState;
let usedState: LocalState;
let markedState: LocalState;
let datelessState: LocalState;
let store: FakeStore;
const config = () =>
	loadConfig({ env: { DMN_STORE_URL: "fake:" }, configDir: join(scratch, "no-config") });
const ids = {} as Record<"old" | "protected" | "fresh" | "revived", string>;

/** The creation time a FakeStore stamps; each test or fixture owns one. */
interface Clock {
	at: Date;
}

/** Retains one memory created `daysOld` days before `now` and returns its id. */
async function seed(target: FakeStore, holder: Clock, daysOld: number, tag: string) {
	holder.at = new Date(now.getTime() - daysOld * day);
	await target.retain(bank, [{ content: "memory widgets", tags: [tag] }]);
	const all = await target.list(bank, { limit: 100, offset: 0 });
	return all[all.length - 1]?.id as string;
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-sweep-"));
	state = new LocalState({ directory: join(scratch, "main"), clock: () => now });
	pagedState = new LocalState({ directory: join(scratch, "paged"), clock: () => now });
	usedState = new LocalState({ directory: join(scratch, "used"), clock: () => now });
	markedState = new LocalState({ directory: join(scratch, "marked"), clock: () => now });
	datelessState = new LocalState({ directory: join(scratch, "dateless"), clock: () => now });
	const holder: Clock = { at: now };
	store = new FakeStore(() => holder.at);
	ids.old = await seed(store, holder, 400, "project:widgets");
	ids.protected = await seed(store, holder, 400, "decision");
	ids.fresh = await seed(store, holder, 1, "project:widgets");
	ids.revived = await seed(store, holder, 400, "project:widgets");
	state.setDormant(ids.revived);
	state.revive(ids.revived);
});

afterAll(() => {
	state.close();
	pagedState.close();
	usedState.close();
	markedState.close();
	datelessState.close();
	rmSync(scratch, { recursive: true, force: true });
});

test("dormancy: old unused goes dormant, protected and fresh stay, dry run writes nothing, recall skips it", async () => {
	const input = { store, state, config: config(), banks: [bank], now };

	const dry = await sweep({ ...input, dryRun: true });
	expect(dry).toEqual({
		examined: 4,
		dormant: [ids.old, ids.revived],
		protectedKept: [ids.protected],
	});
	for (const id of Object.values(ids)) expect(state.isDormant(id)).toBe(false);

	// A revive clears dormancy once: the revived memory is still below the floor, so it returns.
	const result = await sweep(input);
	expect(result).toEqual(dry);
	expect(state.isDormant(ids.old)).toBe(true);
	expect(state.isDormant(ids.revived)).toBe(true);
	expect(state.isDormant(ids.protected)).toBe(false);
	expect(state.isDormant(ids.fresh)).toBe(false);

	const cue = {
		organization: "generic",
		project: "widgets",
		stack: [],
		role: "unknown" as const,
		task: "read" as const,
	};
	const recalled = await recall({
		store,
		state,
		config: config(),
		cue,
		prompt: "widgets",
		now,
		random: () => 0.5,
	});
	expect(recalled.map((memory) => memory.id)).toEqual([ids.fresh]);
});

test("a use lifts a memory above the floor", async () => {
	const holder: Clock = { at: now };
	const other = new FakeStore(() => holder.at);
	const used = await seed(other, holder, 400, "project:widgets");
	for (let turn = 0; turn < 40; turn++) usedState.recordUse(used, `t${turn}`);
	const result = await sweep({
		store: other,
		state: usedState,
		config: config(),
		banks: [bank],
		now,
	});
	expect(result).toEqual({ examined: 1, dormant: [], protectedKept: [] });
});

test("a memory with no usable age is examined and never marked", async () => {
	const dateless: MemoryStore = {
		list: async (_bank: string, { offset }: ListQuery) =>
			offset === 0 ? [{ id: "dateless", text: "x", tags: [], createdAt: "not a date" }] : [],
	} as unknown as MemoryStore;
	const result = await sweep({
		store: dateless,
		state: datelessState,
		config: config(),
		banks: [bank],
		now,
	});
	expect(result).toEqual({ examined: 1, dormant: [], protectedKept: [] });
	expect(datelessState.isDormant("dateless")).toBe(false);
});

test("lists every page: 7 memories with a page size of 3", async () => {
	const paged = new FakeStore(() => new Date(now.getTime() - 400 * day));
	await paged.retain(
		"paged",
		Array.from({ length: 7 }, (_, index) => ({ content: `m${index}`, tags: [] })),
	);
	const result = await sweep({
		store: paged,
		state: pagedState,
		config: config(),
		banks: ["paged"],
		now,
		dryRun: true,
		pageSize: 3,
	});
	expect(result.examined).toBe(7);
	expect(result.dormant).toHaveLength(7);
});

test("memories already dormant are examined but not reported again", async () => {
	markedState.setDormant(ids.old);
	// Dormant and protected (the tag came later): still skipped, not reported as kept.
	markedState.setDormant(ids.protected);
	const result = await sweep({ store, state: markedState, config: config(), banks: [bank], now });
	expect(result).toEqual({
		examined: 4,
		dormant: [ids.revived],
		protectedKept: [],
	});
});
