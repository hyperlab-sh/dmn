import { beforeAll, expect, test } from "bun:test";
import { estimateTokens } from "../recall/inject.js";
import { FakeStore } from "../store/fake.js";
import type { MemoryStore, MentalModel, MentalModelInput } from "../store/types.js";
import { rosterLines, rosterRoles, syncRoster } from "./roster.js";

const now = new Date("2026-06-01T00:00:00Z");
const bank = "org-acme";
// The failure rows work on their own banks of the shared store, so no row reads another's writes.
const refusedCreateBank = "org-refused-create";
const refusedRefreshBank = "org-refused-refresh";

/** Records every roster write, so the create/refresh counts and shapes are observable. */
class RosterSpy extends FakeStore {
	created: { bank: string; model: MentalModelInput }[] = [];
	refreshed: { bank: string; id: string }[] = [];
	override async createMentalModel(bank: string, model: MentalModelInput): Promise<void> {
		this.created.push({ bank, model });
		await super.createMentalModel(bank, model);
	}
	override async refreshMentalModel(bank: string, id: string): Promise<void> {
		this.refreshed.push({ bank, id });
		await super.refreshMentalModel(bank, id);
	}
}

/**
 * Wraps the file's shared store, refusing the roster writes one row wants to see fail; every
 * other call delegates, so the row syncs against the same fixture the other rows assert on.
 */
function refusingRosterStore(
	refuse: (kind: "create" | "refresh", bank: string, id: string) => boolean,
): MemoryStore {
	return new Proxy<MemoryStore>(store, {
		get(target, property) {
			if (property === "createMentalModel" || property === "refreshMentalModel") {
				return (visited: string, ...rest: unknown[]) => {
					const kind = property === "createMentalModel" ? "create" : "refresh";
					const id =
						property === "createMentalModel" ? (rest[0] as MentalModelInput).id : String(rest[0]);
					if (refuse(kind, visited, id)) throw new Error(`${property} refused`);
					return (target[property] as (...args: unknown[]) => unknown)(visited, ...rest);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

let store: RosterSpy;
/** The fixture's first sync, kept as it happened; later rows append to the live arrays. */
let firstCreated: { bank: string; model: MentalModelInput }[];
let firstRefreshed: { bank: string; id: string }[];

// Built once: the two-role bank, then the first roster sync whose records the first two rows
// assert. No row depends on another row having run.
beforeAll(async () => {
	store = new RosterSpy(() => now);
	await store.retain(bank, [
		{
			content: "The reviewer cites the design doc. Flaky tests are tracked.",
			tags: ["role:reviewer", "kind:decision"],
		},
		{ content: "The developer keeps the build green.", tags: ["role:developer"] },
		{ content: "an operator runbook line one\nand a second line", tags: ["role:operator"] },
	]);
	const warnings: string[] = [];
	await syncRoster(store, bank, rosterRoles, { onWarning: (message) => warnings.push(message) });
	expect(warnings).toEqual([]);
	firstCreated = store.created.map((entry) => ({ bank: entry.bank, model: { ...entry.model } }));
	firstRefreshed = store.refreshed.map((entry) => ({ ...entry }));
});

test("the first sync creates the four role models with the pinned shape and refreshes every one", async () => {
	expect(firstCreated.map((entry) => entry.model.id)).toEqual([
		"dmn-role-architect",
		"dmn-role-developer",
		"dmn-role-reviewer",
		"dmn-role-operator",
	]);
	// The pinned shape whole, expected with the literal D31 source query.
	expect(firstCreated.filter((entry) => entry.model.id === "dmn-role-reviewer")).toEqual([
		{
			bank,
			model: {
				id: "dmn-role-reviewer",
				name: "dmn-role-reviewer",
				sourceQuery:
					"What the reviewer role's memories cover: the facts, decisions and habits this role relies on",
				tags: ["role:reviewer"],
				maxTokens: 512,
			},
		},
	]);
	expect(firstRefreshed.map((entry) => entry.id)).toEqual([
		"dmn-role-architect",
		"dmn-role-developer",
		"dmn-role-reviewer",
		"dmn-role-operator",
	]);
	// The fake built each model's content from its role's memories: first lines only.
	const models = await store.mentalModels(bank);
	expect(models.find((model) => model.role === "reviewer")?.content).toBe(
		"The reviewer cites the design doc. Flaky tests are tracked.",
	);
	expect(models.find((model) => model.role === "operator")?.content).toBe(
		"an operator runbook line one",
	);
	// A role with no memories gets its model, with nothing to say yet.
	expect(models.find((model) => model.role === "architect")?.content).toBe("");
	expect(new Set(models.map((model) => model.refreshedAt))).toEqual(
		new Set(["2026-06-01T00:00:00.000Z"]),
	);
});

test("a second sync creates none and refreshes the four", async () => {
	// Deltas against the live log, so the row stands on its own whatever ran before it.
	const createdBefore = store.created.length;
	const refreshedBefore = store.refreshed.length;
	await syncRoster(store, bank, rosterRoles);
	expect(store.created.length).toBe(createdBefore);
	expect(store.refreshed.slice(refreshedBefore).map((entry) => entry.id)).toHaveLength(4);
});

test("a create the store refuses is one warning and the sync continues with the other roles", async () => {
	const warnings: string[] = [];
	await syncRoster(
		refusingRosterStore(
			(kind, visited, id) =>
				kind === "create" && visited === refusedCreateBank && id === "dmn-role-reviewer",
		),
		refusedCreateBank,
		rosterRoles,
		{ onWarning: (message) => warnings.push(message) },
	);
	expect(warnings).toEqual([expect.stringContaining("reviewer")]);
	// The other three were created; nothing threw.
	expect((await store.mentalModels(refusedCreateBank)).map((model) => model.role).sort()).toEqual([
		"architect",
		"developer",
		"operator",
	]);
});

test("a refresh the store refuses is one warning per model and the sync still finishes", async () => {
	const warnings: string[] = [];
	await syncRoster(
		refusingRosterStore((kind, visited) => kind === "refresh" && visited === refusedRefreshBank),
		refusedRefreshBank,
		rosterRoles,
		{ onWarning: (message) => warnings.push(message) },
	);
	expect(warnings).toHaveLength(4);
	// The creates were not rolled back by the failed refreshes.
	expect(await store.mentalModels(refusedRefreshBank)).toHaveLength(4);
});

const reviewerModel = (content: string): MentalModel => ({
	id: "dmn-role-reviewer",
	role: "reviewer",
	content,
	refreshedAt: "2026-01-01T00:00:00Z",
});

test("a roster line carries the model's first sentence, flattened, capped at 200 characters", () => {
	for (const [content, sentence] of [
		[
			"The reviewer cites the design doc. Flaky tests are tracked.",
			"The reviewer cites the design doc.",
		],
		["A question? Yes.", "A question?"],
		["No end here", "No end here"],
		["x".repeat(250), "x".repeat(200)],
		["  \n spaced\tout.  ", "spaced out."],
	] as const) {
		expect(rosterLines([reviewerModel(content)], "developer", 600)).toEqual([
			`[roster:reviewer] ${sentence}`,
		]);
	}
});

test("rosterLines skips the own role and a model with nothing to say", () => {
	expect(
		rosterLines([reviewerModel("The reviewer cites the design doc.")], "reviewer", 600),
	).toEqual([]);
	expect(rosterLines([reviewerModel("")], "developer", 600)).toEqual([]);
	expect(rosterLines([reviewerModel("   \n ")], "developer", 600)).toEqual([]);
});

test("a roster line that does not fit the remaining budget is dropped, a later shorter one kept", () => {
	const long = "r".repeat(200);
	const short = "s".repeat(20);
	const models = [
		{ id: "a", role: "reviewer", content: long, refreshedAt: "2026-01-01T00:00:00Z" },
		{ id: "b", role: "operator", content: long, refreshedAt: "2026-01-01T00:00:00Z" },
		{ id: "c", role: "architect", content: short, refreshedAt: "2026-01-01T00:00:00Z" },
	];
	const lines = rosterLines(models, "developer", 100);
	expect(lines).toHaveLength(2);
	expect(lines[0]?.startsWith("[roster:reviewer]")).toBe(true);
	expect(lines[1]?.startsWith("[roster:architect]")).toBe(true);
	expect(estimateTokens(lines.join("\n"))).toBeLessThanOrEqual(100);
});
