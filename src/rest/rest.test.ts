import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { LocalState } from "../state/state.js";
import { StoreError } from "../store/errors.js";
import { FakeStore } from "../store/fake.js";
import type { RetainItem } from "../store/types.js";
import { runRest } from "./rest.js";

const now = new Date("2026-06-01T00:00:00Z");
const bank = "org-acme";
const quietBank = "org-quiet";
const generic = "generic";

type Key = "projectLearning" | "orgLearning" | "singleProject" | "turn" | "genericLearning";

/** The fixture's items, defined once: the four-memory bank, a bank with no learning, and a
 * project-tagged learning (with an organization tag) already living in the generic bank. */
const bankItems: RetainItem[] = [
	{ content: "learning from project a", tags: ["project:a", "kind:learning"] },
	{ content: "learning without a project", tags: ["kind:learning"] },
	{ content: "learning used in one project only", tags: ["project:a", "kind:learning"] },
	{ content: "a turn, not a learning", tags: ["project:a", "kind:turn"] },
];
const quietItems: RetainItem[] = [{ content: "a quiet turn", tags: ["project:a", "kind:turn"] }];
const genericItems: RetainItem[] = [
	{ content: "generic learning from project a", tags: ["project:a", "org:acme", "kind:learning"] },
];

/** The store under test: a fake that records every retain call for the apply assertions. */
class RetainSpy extends FakeStore {
	retained: { bank: string; items: RetainItem[] }[] = [];
	override retain(bank: string, items: RetainItem[]): Promise<void> {
		this.retained.push({ bank, items });
		return super.retain(bank, items);
	}
}

/** Refuses exactly the promotion copies bound for one bank; the seeding still goes through. */
class RefusingStore extends FakeStore {
	constructor(
		private readonly refusedBank: string,
		clock: () => Date,
	) {
		super(clock);
	}
	override async retain(bank: string, items: RetainItem[]): Promise<void> {
		if (
			bank === this.refusedBank &&
			items.some((item) => item.documentId?.startsWith("promotion:"))
		) {
			throw new Error("store refused the promotion");
		}
		await super.retain(bank, items);
	}
}

/** A store whose consolidation fails hard for one bank. */
class FailingConsolidationStore extends FakeStore {
	constructor(
		private readonly failingBank: string,
		clock: () => Date,
	) {
		super(clock);
	}
	override async consolidate(bank: string): Promise<{ operationId: string; deduplicated: number }> {
		if (bank === this.failingBank) {
			throw new StoreError(`POST consolidate failed: 500 consolidation exploded`, 500);
		}
		return super.consolidate(bank);
	}
}

interface Seeded {
	store: RetainSpy;
	ids: Record<Key, string>;
}

/** Seeds the fixture into a fresh store (the shared one, or a subclass an apply test needs). */
async function seedStore(make: () => FakeStore = () => new RetainSpy(() => now)): Promise<Seeded> {
	const store = make();
	await store.retain(bank, bankItems);
	await store.retain(quietBank, quietItems);
	await store.retain(generic, genericItems);
	const all = await store.list(bank, { limit: 10, offset: 0 });
	const idOf = (text: string) => all.find((memory) => memory.text === text)?.id as string;
	const genericAll = await store.list(generic, { limit: 10, offset: 0 });
	if (store instanceof RetainSpy) {
		// The seeding itself must not count as a promotion retain.
		store.retained.length = 0;
	}
	return {
		store: store as RetainSpy,
		ids: {
			projectLearning: idOf("learning from project a"),
			orgLearning: idOf("learning without a project"),
			singleProject: idOf("learning used in one project only"),
			turn: idOf("a turn, not a learning"),
			genericLearning:
				genericAll.find((memory) => memory.text === "generic learning from project a")?.id ?? "",
		},
	};
}

/** Uses across projects: three memories in a and b, the single-project one in a only. */
function seedUses(state: LocalState, ids: Record<Key, string>): void {
	for (const id of [ids.projectLearning, ids.orgLearning, ids.turn, ids.genericLearning]) {
		state.recordUse(id, "turn-1", "a");
		state.recordUse(id, "turn-2", "b");
	}
	state.recordUse(ids.singleProject, "turn-1", "a");
}

let scratch: string;
let states: LocalState[];
let seeded: Seeded;
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

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-rest-"));
	states = [];
	// The fixture is built once; only the apply tests take a fresh store from seedStore().
	seeded = await seedStore();
});

afterAll(() => {
	for (const state of states) state.close();
	rmSync(scratch, { recursive: true, force: true });
});

test("a learning used across two projects is proposed for the wider scope; nothing is written", async () => {
	const state = newState();
	seedUses(state, seeded.ids);
	// pageSize 1 walks the candidate list one page per memory, proving the paging loop.
	const report = await runRest(seeded.store, state, config(), { banks: [bank], now, pageSize: 1 });
	const entry = report.banks[0];
	expect(entry?.consolidation).toEqual({ operationId: "fake", deduplicated: 0 });
	expect(entry?.learnings).toBe(3);
	expect(entry?.applied).toEqual([]);
	const proposals = report.banks.flatMap((item) => item.proposals);
	expect(proposals).toHaveLength(2);
	expect(proposals.find((proposal) => proposal.id === seeded.ids.projectLearning)).toMatchObject({
		fromScope: "project",
		toScope: "organization",
		fromBank: bank,
		toBank: bank,
		projects: ["a", "b"],
		content: "learning from project a",
		tags: ["kind:learning"],
	});
	expect(proposals.find((proposal) => proposal.id === seeded.ids.orgLearning)).toMatchObject({
		fromScope: "organization",
		toScope: "generic",
		fromBank: bank,
		toBank: generic,
		projects: ["a", "b"],
		content: "learning without a project",
		tags: ["kind:learning"],
	});
	// One project is not enough, and a turn is not a learning.
	expect(proposals.map((proposal) => proposal.id)).not.toContain(seeded.ids.singleProject);
	expect(proposals.map((proposal) => proposal.id)).not.toContain(seeded.ids.turn);
	// Nothing was written: no copy, no dormancy, no promotion.
	expect(seeded.store.retained).toEqual([]);
	expect(state.isDormant(seeded.ids.projectLearning)).toBe(false);
	expect(state.isPromoted(seeded.ids.projectLearning)).toBe(false);
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
			bank: generic,
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
	expect(await store.list(generic, { limit: 10, offset: 0 })).toHaveLength(2);
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
	const state = newState();
	seedUses(state, seeded.ids);
	state.setDormant(seeded.ids.projectLearning);
	state.recordPromotion(seeded.ids.orgLearning, "generic");
	const report = await runRest(seeded.store, state, config(), { banks: [bank], now });
	expect(report.banks[0]?.proposals).toEqual([]);
	expect(seeded.store.retained).toEqual([]);
});

test("a bank with no memory tagged kind:learning has no candidates and proposes nothing", async () => {
	const report = await runRest(seeded.store, newState(), config(), { banks: [quietBank], now });
	const entry = report.banks[0];
	expect(entry?.learnings).toBe(0);
	expect(entry?.proposals).toEqual([]);
});

test("a bank the store does not know is reported as skipped, not an error", async () => {
	const report = await runRest(seeded.store, newState(), config(), {
		banks: [bank, "never-written"],
		now,
	});
	expect(report.banks.map((entry) => entry.bank)).toEqual([bank, "never-written"]);
	expect(report.banks[0]?.consolidation).toEqual({ operationId: "fake", deduplicated: 0 });
	expect(report.banks[1]?.consolidation).toBeNull();
	expect(report.banks[1]?.error).toBeUndefined();
});

test("without banks, rest takes generic and every organization bank, deduplicated", async () => {
	const configDir = join(scratch, "orgs-config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ organizations: { "space-one": "acme", "space-two": "acme" } }),
	);
	// Only the organization bank exists; generic is skipped on the fake, but still visited.
	const store = new FakeStore(() => now);
	await store.retain(bank, bankItems);
	const report = await runRest(
		store,
		newState(),
		loadConfig({ env: { DMN_STORE_URL: "fake:" }, configDir }),
		{ now },
	);
	expect(report.banks.map((entry) => entry.bank)).toEqual([generic, bank]);
	expect(report.banks[0]?.consolidation).toBeNull();
	expect(report.banks[1]?.consolidation).toEqual({ operationId: "fake", deduplicated: 0 });
});

test("a project-tagged learning in the generic bank widens to generic scope and drops the organization tag", async () => {
	const state = newState();
	seedUses(state, seeded.ids);
	const report = await runRest(seeded.store, state, config(), { banks: [generic], now });
	const proposal = report.banks[0]?.proposals[0];
	expect(proposal).toMatchObject({
		id: seeded.ids.genericLearning,
		fromScope: "project",
		toScope: "generic",
		fromBank: generic,
		toBank: generic,
		tags: ["kind:learning"],
	});
	expect(report.banks[0]?.learnings).toBe(1);
});

test("a promotion the store refuses is failed, not applied, and the rest of the run continues", async () => {
	const { store, ids } = await seedStore(() => new RefusingStore(generic, () => now));
	const state = newState();
	seedUses(state, ids);
	const warnings: string[] = [];
	const report = await runRest(store, state, config(), {
		banks: [bank],
		apply: true,
		now,
		onWarning: (message) => warnings.push(message),
	});
	// The organization-scope promotion (same bank) applied; the generic-bound one was refused.
	expect(report.banks[0]?.applied).toEqual([ids.projectLearning]);
	expect(report.banks[0]?.failed).toEqual([ids.orgLearning]);
	expect(warnings).toEqual([expect.stringContaining(ids.orgLearning)]);
	// The refused original keeps its scope and its promotion stays unrecorded: retriable.
	expect(state.isDormant(ids.orgLearning)).toBe(false);
	expect(state.isPromoted(ids.orgLearning)).toBe(false);
	expect(state.isDormant(ids.projectLearning)).toBe(true);
});

test("a bank whose pass fails is reported and the run continues with the others", async () => {
	const seededFailing = await seedStore(() => new FailingConsolidationStore("org-boom", () => now));
	const state = newState();
	seedUses(state, seededFailing.ids);
	const warnings: string[] = [];
	const report = await runRest(seededFailing.store, state, config(), {
		banks: [bank, "org-boom"],
		apply: true,
		now,
		onWarning: (message) => warnings.push(message),
	});
	// The healthy bank's report and its applied promotions survive the other bank's failure.
	expect(report.banks[0]?.applied).toEqual([
		seededFailing.ids.projectLearning,
		seededFailing.ids.orgLearning,
	]);
	expect(report.banks[1]?.error).toContain("consolidation exploded");
	expect(report.banks[1]?.applied).toEqual([]);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("org-boom");
});

test("a roster step that throws is the bank's failure, and the bank's report survives it", async () => {
	const state = newState();
	seedUses(state, seeded.ids);
	const report = await runRest(seeded.store, state, config(), {
		banks: [bank],
		now,
		syncRoster: () => {
			throw new Error("roster down");
		},
	});
	// Consolidation and proposals ran before the roster; only the last step failed.
	expect(report.banks[0]?.consolidation).toEqual({ operationId: "fake", deduplicated: 0 });
	expect(report.banks[0]?.proposals).toHaveLength(2);
	expect(report.banks[0]?.error).toContain("roster down");
});

test("the roster step runs for every bank rest consolidates, and never for a skipped one", async () => {
	const synced: string[] = [];
	const report = await runRest(seeded.store, newState(), config(), {
		banks: [quietBank, bank, "never-written"],
		now,
		syncRoster: (visited) => {
			synced.push(visited);
		},
	});
	// A bank the store does not know is skipped before step 3; the others get their roster.
	expect(synced).toEqual([quietBank, bank]);
	expect(report.banks[2]?.consolidation).toBeNull();
});
