import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import type { RetainItem } from "../store/types.js";
import { runRest } from "./rest.js";

const now = new Date("2026-06-01T00:00:00Z");
const bank = "org-acme";
const quietBank = "org-quiet";

type Key = "projectLearning" | "orgLearning" | "singleProject" | "turn";

/** The store under test: a fake that records every retain call for the apply assertions. */
class RetainSpy extends FakeStore {
	retained: { bank: string; items: RetainItem[] }[] = [];
	override retain(bank: string, items: RetainItem[]): Promise<void> {
		this.retained.push({ bank, items });
		return super.retain(bank, items);
	}
}

interface Seeded {
	store: RetainSpy;
	ids: Record<Key, string>;
}

/** The four-memory bank of the acceptance fixture, plus a bank holding no learning. */
async function seedStore(): Promise<Seeded> {
	const store = new RetainSpy(() => now);
	await store.retain(bank, [
		{ content: "learning from project a", tags: ["project:a", "kind:learning"] },
		{ content: "learning without a project", tags: ["kind:learning"] },
		{ content: "learning used in one project only", tags: ["project:a", "kind:learning"] },
		{ content: "a turn, not a learning", tags: ["project:a", "kind:turn"] },
	]);
	await store.retain(quietBank, [{ content: "a quiet turn", tags: ["project:a", "kind:turn"] }]);
	const all = await store.list(bank, { limit: 10, offset: 0 });
	const idOf = (text: string) => all.find((memory) => memory.text === text)?.id as string;
	// The seeding itself must not count as a promotion retain.
	store.retained.length = 0;
	return {
		store,
		ids: {
			projectLearning: idOf("learning from project a"),
			orgLearning: idOf("learning without a project"),
			singleProject: idOf("learning used in one project only"),
			turn: idOf("a turn, not a learning"),
		},
	};
}

/** Uses across projects: three memories in a and b, the single-project one in a only. */
function seedUses(state: LocalState, ids: Record<Key, string>): void {
	for (const id of [ids.projectLearning, ids.orgLearning, ids.turn]) {
		state.recordUse(id, "turn-1", "a");
		state.recordUse(id, "turn-2", "b");
	}
	state.recordUse(ids.singleProject, "turn-1", "a");
}

let scratch: string;
let states: LocalState[];
const config = () =>
	loadConfig({ env: { DMN_STORE_URL: "fake:" }, configDir: join(scratch, "no-config") });

/** A fresh state per test: the apply tests mutate theirs, and no test reads another's writes. */
function newState(): LocalState {
	const state = new LocalState({
		directory: join(scratch, `state-${states.length}`),
		clock: () => now,
	});
	states.push(state);
	return state;
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-rest-"));
	states = [];
});

afterAll(() => {
	for (const state of states) state.close();
	rmSync(scratch, { recursive: true, force: true });
});

test("a learning used across two projects is proposed for the wider scope; nothing is written", async () => {
	const { store, ids } = await seedStore();
	const state = newState();
	seedUses(state, ids);
	const report = await runRest(store, state, config(), { banks: [bank], now });
	const entry = report.banks[0];
	expect(entry?.consolidation).toEqual({ operationId: "fake", deduplicated: 0 });
	expect(entry?.learnings).toBe(3);
	expect(entry?.applied).toEqual([]);
	const proposals = report.banks.flatMap((item) => item.proposals);
	expect(proposals).toHaveLength(2);
	expect(proposals.find((proposal) => proposal.id === ids.projectLearning)).toMatchObject({
		fromScope: "project",
		toScope: "organization",
		fromBank: bank,
		toBank: bank,
		projects: ["a", "b"],
		content: "learning from project a",
		tags: ["kind:learning"],
	});
	expect(proposals.find((proposal) => proposal.id === ids.orgLearning)).toMatchObject({
		fromScope: "organization",
		toScope: "generic",
		fromBank: bank,
		toBank: "generic",
		projects: ["a", "b"],
		content: "learning without a project",
		tags: ["kind:learning"],
	});
	// One project is not enough, and a turn is not a learning.
	expect(proposals.map((proposal) => proposal.id)).not.toContain(ids.singleProject);
	expect(proposals.map((proposal) => proposal.id)).not.toContain(ids.turn);
	// Nothing was written: no copy, no dormancy, no promotion.
	expect(store.retained).toEqual([]);
	expect(state.isDormant(ids.projectLearning)).toBe(false);
	expect(state.isPromoted(ids.projectLearning)).toBe(false);
});

test("apply retains one copy per proposal, marks the originals dormant and records the promotions", async () => {
	const { store, ids } = await seedStore();
	const state = newState();
	seedUses(state, ids);
	const report = await runRest(store, state, config(), { banks: [bank], apply: true, now });
	expect(report.banks[0]?.applied).toEqual([ids.projectLearning, ids.orgLearning]);
	expect(store.retained).toEqual([
		{
			bank,
			items: [
				{
					content: "learning from project a",
					tags: ["kind:learning"],
					documentId: `promotion:${ids.projectLearning}`,
					metadata: { promoted_from: ids.projectLearning, promoted_at: now.toISOString() },
				},
			],
		},
		{
			bank: "generic",
			items: [
				{
					content: "learning without a project",
					tags: ["kind:learning"],
					documentId: `promotion:${ids.orgLearning}`,
					metadata: { promoted_from: ids.orgLearning, promoted_at: now.toISOString() },
				},
			],
		},
	]);
	expect(state.isDormant(ids.projectLearning)).toBe(true);
	expect(state.isDormant(ids.orgLearning)).toBe(true);
	expect(state.isPromoted(ids.projectLearning)).toBe(true);
	expect(state.isPromoted(ids.orgLearning)).toBe(true);
	// The copies sit beside the originals: nothing was deleted, and the originals stay dormant.
	expect(await store.list(bank, { limit: 10, offset: 0 })).toHaveLength(5);
	expect(await store.list("generic", { limit: 10, offset: 0 })).toHaveLength(1);
});

test("a second apply proposes nothing and retains nothing", async () => {
	const { store, ids } = await seedStore();
	const state = newState();
	seedUses(state, ids);
	await runRest(store, state, config(), { banks: [bank], apply: true, now });
	store.retained.length = 0;
	const again = await runRest(store, state, config(), { banks: [bank], apply: true, now });
	expect(again.banks[0]?.proposals).toEqual([]);
	expect(again.banks[0]?.applied).toEqual([]);
	expect(store.retained).toEqual([]);
});

test("a learning already dormant or already promoted is not proposed again", async () => {
	const { store, ids } = await seedStore();
	const state = newState();
	seedUses(state, ids);
	state.setDormant(ids.projectLearning);
	state.recordPromotion(ids.orgLearning, "generic");
	const report = await runRest(store, state, config(), { banks: [bank], now });
	expect(report.banks[0]?.proposals).toEqual([]);
	expect(store.retained).toEqual([]);
});

test("a bank with no memory tagged kind:learning has no candidates and proposes nothing", async () => {
	const { store } = await seedStore();
	const report = await runRest(store, newState(), config(), { banks: [quietBank], now });
	const entry = report.banks[0];
	expect(entry?.learnings).toBe(0);
	expect(entry?.proposals).toEqual([]);
});

test("a bank the store does not know is reported as skipped, not an error", async () => {
	const { store } = await seedStore();
	const report = await runRest(store, newState(), config(), {
		banks: [bank, "never-written"],
		now,
	});
	expect(report.banks.map((entry) => entry.bank)).toEqual([bank, "never-written"]);
	expect(report.banks[0]?.consolidation).toEqual({ operationId: "fake", deduplicated: 0 });
	expect(report.banks[1]?.consolidation).toBeNull();
});
