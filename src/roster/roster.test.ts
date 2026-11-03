import { beforeAll, expect, test } from "bun:test";
import { estimateTokens } from "../recall/inject.js";
import { FakeStore } from "../store/fake.js";
import type { MentalModel, MentalModelInput } from "../store/types.js";
import {
	firstSentence,
	rosterLines,
	rosterRoles,
	rosterSourceQuery,
	syncRoster,
} from "./roster.js";

const now = new Date("2026-06-01T00:00:00Z");
const bank = "org-acme";

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

/** Refuses the create of one role's model; the rest of the roster pass goes on. */
class RefusingCreateStore extends RosterSpy {
	constructor(
		private readonly refusedRole: string,
		clock: () => Date,
	) {
		super(clock);
	}
	override async createMentalModel(bank: string, model: MentalModelInput): Promise<void> {
		if (model.tags.includes(`role:${this.refusedRole}`)) throw new Error("model refused");
		await super.createMentalModel(bank, model);
	}
}

/** Fails every refresh; the creates still happen. */
class FailingRefreshStore extends RosterSpy {
	override async refreshMentalModel(bank: string, id: string): Promise<void> {
		this.refreshed.push({ bank, id });
		throw new Error("refresh refused");
	}
}

let store: RosterSpy;

// The fixture is built once; the second-run test builds on the first run's models.
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
});

test("syncRoster creates the four role models with the pinned shape and refreshes every one", async () => {
	const warnings: string[] = [];
	await syncRoster(store, bank, rosterRoles, { onWarning: (message) => warnings.push(message) });
	expect(warnings).toEqual([]);
	expect(store.created.map((entry) => entry.model.id)).toEqual([
		"dmn-role-architect",
		"dmn-role-developer",
		"dmn-role-reviewer",
		"dmn-role-operator",
	]);
	// The pinned shape, asserted whole for one role (D31).
	expect(store.created.filter((entry) => entry.model.id === "dmn-role-reviewer")).toEqual([
		{
			bank,
			model: {
				id: "dmn-role-reviewer",
				name: "dmn-role-reviewer",
				sourceQuery: rosterSourceQuery("reviewer"),
				tags: ["role:reviewer"],
				maxTokens: 512,
			},
		},
	]);
	expect(store.refreshed.map((entry) => entry.id)).toEqual([
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
	store.created.length = 0;
	store.refreshed.length = 0;
	await syncRoster(store, bank, rosterRoles);
	expect(store.created).toEqual([]);
	expect(store.refreshed.map((entry) => entry.id)).toHaveLength(4);
});

test("a create the store refuses is one warning and the sync continues with the other roles", async () => {
	const refusing = new RefusingCreateStore("reviewer", () => now);
	await refusing.retain(bank, [
		{ content: "The reviewer cites the design doc.", tags: ["role:reviewer"] },
	]);
	const warnings: string[] = [];
	await syncRoster(refusing, bank, rosterRoles, { onWarning: (message) => warnings.push(message) });
	expect(warnings).toEqual([expect.stringContaining("reviewer")]);
	// The other three were created; nothing threw.
	expect((await refusing.mentalModels(bank)).map((model) => model.role).sort()).toEqual([
		"architect",
		"developer",
		"operator",
	]);
});

test("a refresh the store refuses is one warning per model and the sync still finishes", async () => {
	const failing = new FailingRefreshStore(() => now);
	const warnings: string[] = [];
	await syncRoster(failing, bank, rosterRoles, { onWarning: (message) => warnings.push(message) });
	expect(warnings).toHaveLength(4);
	// The creates were not rolled back by the failed refreshes.
	expect(await failing.mentalModels(bank)).toHaveLength(4);
});

const model = (role: string, content: string): MentalModel => ({
	id: `dmn-role-${role}`,
	role,
	content,
	refreshedAt: "2026-01-01T00:00:00Z",
});

test("the first sentence runs to a period followed by a space, else the first 200 characters", () => {
	expect(firstSentence("One. Two. Three.")).toBe("One.");
	expect(firstSentence("A question? Yes.")).toBe("A question?");
	expect(firstSentence("No end here")).toBe("No end here");
	expect(firstSentence("x".repeat(250))).toBe("x".repeat(200));
	expect(firstSentence("  \n spaced\tout.  ")).toBe("spaced out.");
});

test("rosterLines takes each model's first sentence, skipping the own role and empty content", () => {
	const lines = rosterLines(
		[
			model("developer", "The developer keeps the build green.\nAlso runs migrations."),
			model("reviewer", "The reviewer cites the design doc. Flaky tests are tracked."),
			model("architect", ""),
			model("operator", "an operator runbook with no sentence end at all"),
		],
		"developer",
		600,
	);
	expect(lines).toEqual([
		"[roster:reviewer] The reviewer cites the design doc.",
		"[roster:operator] an operator runbook with no sentence end at all",
	]);
});

test("a roster line that does not fit the remaining budget is dropped, a later shorter one kept", () => {
	const long = "r".repeat(200);
	const short = "s".repeat(20);
	const lines = rosterLines(
		[model("reviewer", long), model("operator", long), model("architect", short)],
		"developer",
		100,
	);
	expect(lines).toHaveLength(2);
	expect(lines[0]?.startsWith("[roster:reviewer]")).toBe(true);
	expect(lines[1]?.startsWith("[roster:architect]")).toBe(true);
	expect(estimateTokens(lines.join("\n"))).toBeLessThanOrEqual(100);
});
