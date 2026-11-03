import { afterAll, beforeAll, expect, test } from "bun:test";
import { FakeStore, startFakeServer } from "./fake.js";
import { HindsightStore, StoreError } from "./hindsight.js";
import type { MemoryRecord } from "./types.js";

const bank = "org-acme";
let server: ReturnType<typeof startFakeServer>;
let store: HindsightStore;
let recalled: MemoryRecord[];

beforeAll(async () => {
	server = startFakeServer();
	store = new HindsightStore({ baseUrl: server.url });
	await store.retain(bank, [
		{ content: "deploy the api with docker compose", tags: ["project:api", "stack:docker"] },
		{ content: "api tests run with bun test", tags: ["project:api", "stack:bun"], context: "ci" },
		{ content: "the web app uses react", tags: ["project:web"], metadata: { source: "note" } },
		{ content: "deploy api with bun", tags: ["project:api"] },
		{ content: "api notes with bun", tags: [] },
	]);
	recalled = await store.recall(bank, {
		query: "run api tests with bun",
		tagsMatch: "any",
		topK: 10,
	});
});

afterAll(() => server.stop());

test("recall orders by keyword overlap, ties by insertion order", async () => {
	expect(recalled.map((record) => record.text)).toEqual([
		"api tests run with bun test",
		"deploy api with bun",
		"api notes with bun",
		"deploy the api with docker compose",
		"the web app uses react",
	]);
	expect(recalled.map((record) => record.score?.final)).toEqual([5, 3, 3, 2, 0]);
	const top = await store.recall(bank, { query: "run api tests with bun", topK: 1 });
	expect(top).toHaveLength(1);
});

test("tagsMatch any includes untagged memories, all_strict excludes them", async () => {
	const lenient = await store.recall(bank, {
		query: "api",
		tags: ["project:api"],
		tagsMatch: "any",
		topK: 10,
	});
	expect(lenient.map((record) => record.text).sort()).toEqual([
		"api notes with bun",
		"api tests run with bun test",
		"deploy api with bun",
		"deploy the api with docker compose",
	]);
	const strict = await store.recall(bank, {
		query: "api",
		tags: ["project:api"],
		tagsMatch: "all_strict",
		topK: 10,
	});
	expect(strict.map((record) => record.text).sort()).toEqual([
		"api tests run with bun test",
		"deploy api with bun",
		"deploy the api with docker compose",
	]);
});

test("all_strict keeps only memories holding every tag", async () => {
	const found = await store.recall(bank, {
		query: "api",
		tags: ["project:api", "stack:bun"],
		tagsMatch: "all_strict",
		topK: 10,
	});
	expect(found.map((record) => record.text)).toEqual(["api tests run with bun test"]);
	expect(found[0]?.tags).toEqual(["project:api", "stack:bun"]);
});

test("get returns a retained item with its fields, and null for an unknown id", async () => {
	const web = recalled.find((record) => record.text.includes("react"));
	const fetched = await store.get(bank, web?.id ?? "");
	expect(fetched?.text).toBe("the web app uses react");
	expect(fetched?.metadata).toEqual({ source: "note" });
	expect(await store.get(bank, "not-a-uuid")).toBeNull();
	expect(await store.get(bank, "00000000-0000-4000-8000-ffffffffffff")).toBeNull();
});

test("list pages through memories and filters by tag", async () => {
	const page = await store.list(bank, { limit: 2, offset: 1 });
	expect(page.map((record) => record.text)).toEqual([
		"api tests run with bun test",
		"the web app uses react",
	]);
	// The adapter asks for any_strict, so untagged memories stay out of a tag-filtered list.
	const api = await store.list(bank, { tags: ["project:api"], limit: 10, offset: 0 });
	expect(api.map((record) => record.text)).toEqual([
		"deploy the api with docker compose",
		"api tests run with bun test",
		"deploy api with bun",
	]);
	const tagged = await store.list(bank, { tags: ["stack:docker"], limit: 10, offset: 0 });
	expect(tagged.map((record) => record.text)).toEqual(["deploy the api with docker compose"]);
});

test("listTags counts tags per bank", async () => {
	const tags = await store.listTags(bank);
	expect(tags).toContainEqual({ tag: "project:api", count: 3 });
	expect(tags).toContainEqual({ tag: "project:web", count: 1 });
	expect(await store.listTags("never-written")).toEqual([]);
});

test("recall and list of a bank nobody wrote to are empty, not errors", async () => {
	expect(await store.list("never-written", { limit: 1, offset: 0 })).toEqual([]);
	expect(await store.recall("never-written", { query: "x", topK: 1 })).toEqual([]);
});

test("a wrong base URL is an error for list and listTags, not an empty store", async () => {
	const wrong = new HindsightStore({ baseUrl: `${server.url}/prefix` });
	await expect(wrong.list(bank, { limit: 1, offset: 0 })).rejects.toBeInstanceOf(StoreError);
	await expect(wrong.listTags(bank)).rejects.toBeInstanceOf(StoreError);
});

test("retain stamps createdAt with the item's content time, falling back to the clock", async () => {
	let stamp = new Date("2026-06-01T00:00:00Z");
	const store = new FakeStore(() => stamp);
	await store.retain("org-acme", [
		{
			content: "a replayed turn from months ago",
			tags: [],
			timestamp: "2026-01-02T09:00:00.000Z",
		},
		{ content: "a live turn stamped now", tags: [] },
	]);
	stamp = new Date("2026-06-02T00:00:00Z");
	const records = await store.list("org-acme", { limit: 10, offset: 0 });
	expect(records.map((record) => record.createdAt)).toEqual([
		"2026-01-02T09:00:00.000Z",
		"2026-06-01T00:00:00.000Z",
	]);
});

test("mental models: create and refresh build content from the role's memories; list maps them", async () => {
	let stamp = new Date("2026-06-01T00:00:00Z");
	const roster = new FakeStore(() => stamp);
	const created = {
		id: "dmn-role-reviewer",
		name: "dmn-role-reviewer",
		sourceQuery: "What the reviewer role's memories cover",
		tags: ["role:reviewer"],
		maxTokens: 512,
	};
	await roster.retain("org-roster", [
		{ content: "The reviewer cites the design doc. Second sentence.", tags: ["role:reviewer"] },
		{ content: "first line of another\nsecond line dropped", tags: ["role:reviewer"] },
		{ content: "a developer memory", tags: ["role:developer"] },
	]);
	await roster.createMentalModel("org-roster", created);
	await expect(roster.mentalModels("org-roster")).resolves.toEqual([
		{
			id: "dmn-role-reviewer",
			role: "reviewer",
			// Only the role's memories, first line of each, joined by a space.
			content: "The reviewer cites the design doc. Second sentence. first line of another",
			refreshedAt: "2026-06-01T00:00:00.000Z",
		},
	]);
	// Refresh rebuilds from the memories the bank holds now, and restamps.
	await roster.retain("org-roster", [
		{ content: "a later reviewer memory", tags: ["role:reviewer"] },
	]);
	stamp = new Date("2026-06-02T00:00:00Z");
	await roster.refreshMentalModel("org-roster", "dmn-role-reviewer");
	await expect(roster.mentalModels("org-roster")).resolves.toEqual([
		{
			id: "dmn-role-reviewer",
			role: "reviewer",
			content:
				"The reviewer cites the design doc. Second sentence. first line of another a later reviewer memory",
			refreshedAt: "2026-06-02T00:00:00.000Z",
		},
	]);
	// The rest of the fake's contract: an unknown bank lists empty, an unknown id fails.
	await expect(roster.mentalModels("never-written")).resolves.toEqual([]);
	await expect(roster.refreshMentalModel("org-roster", "dmn-role-nobody")).rejects.toBeInstanceOf(
		StoreError,
	);
});
