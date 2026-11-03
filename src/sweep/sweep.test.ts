import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { recall } from "../recall/pipeline.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import { sweep } from "./sweep.js";

const now = new Date("2026-06-01T00:00:00Z");
const day = 86_400_000;
const bank = "generic";

let scratch: string;
let state: LocalState;
let store: FakeStore;
let clock = now;
const config = () =>
	loadConfig({ env: { DMN_STORE_URL: "fake:" }, configDir: join(scratch, "no-config") });
const ids = {} as Record<"old" | "protected" | "fresh" | "revived" | "used", string>;

async function seed(name: keyof typeof ids, daysOld: number, tag: string, target = store) {
	clock = new Date(now.getTime() - daysOld * day);
	await target.retain(bank, [{ content: `memory ${name} widgets`, tags: [tag] }]);
	const all = await target.list(bank, { limit: 100, offset: 0 });
	ids[name] = all[all.length - 1]?.id as string;
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-sweep-"));
	state = new LocalState({ directory: scratch, clock: () => now });
	store = new FakeStore(() => clock);
	await seed("old", 400, "project:widgets");
	await seed("protected", 400, "decision");
	await seed("fresh", 1, "project:widgets");
	await seed("revived", 400, "project:widgets");
	state.setDormant(ids.revived);
	state.revive(ids.revived);
});

afterAll(() => {
	state.close();
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
	const recalled = await recall({ store, state, config: config(), cue, prompt: "widgets", now });
	expect(recalled.map((memory) => memory.id)).toEqual([ids.fresh]);
});

test("a use lifts a memory above the floor, and a memory with no usable age is only examined", async () => {
	const other = new FakeStore(() => clock);
	await seed("used", 400, "project:widgets", other);
	await other.retain(bank, [{ content: "no date", tags: [] }]);
	const dateless = (await other.list(bank, { limit: 10, offset: 0 }))[1];
	if (dateless) dateless.createdAt = "not a date";
	// Its own state: ids are per store, so they would collide with the main fixture's.
	const usedState = new LocalState({ directory: join(scratch, "used"), clock: () => now });
	for (let turn = 0; turn < 40; turn++) usedState.recordUse(ids.used, `t${turn}`);
	const result = await sweep({
		store: other,
		state: usedState,
		config: config(),
		banks: [bank],
		now,
	});
	usedState.close();
	expect(result).toEqual({ examined: 2, dormant: [], protectedKept: [] });
});

test("lists every page: 7 memories with a page size of 3", async () => {
	const paged = new FakeStore(() => new Date(now.getTime() - 400 * day));
	await paged.retain(
		"paged",
		Array.from({ length: 7 }, (_, index) => ({ content: `m${index}`, tags: [] })),
	);
	const result = await sweep({
		store: paged,
		state,
		config: config(),
		banks: ["paged"],
		now,
		dryRun: true,
		pageSize: 3,
	});
	expect(result.examined).toBe(7);
	expect(result.dormant).toHaveLength(7);
});
