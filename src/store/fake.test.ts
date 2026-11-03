import { afterAll, beforeAll, expect, test } from "bun:test";
import { startFakeServer } from "./fake.js";
import { HindsightStore } from "./hindsight.js";
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
	]);
	recalled = await store.recall(bank, {
		query: "run api tests with bun",
		tagsMatch: "any",
		topK: 10,
	});
});

afterAll(() => server.stop());

test("recall with tagsMatch any orders by keyword overlap, ties by insertion order", async () => {
	expect(recalled.map((record) => record.text)).toEqual([
		"api tests run with bun test",
		"deploy the api with docker compose",
		"the web app uses react",
	]);
	expect(recalled.map((record) => record.score?.final)).toEqual([5, 2, 0]);
	const top = await store.recall(bank, { query: "run api tests with bun", topK: 1 });
	expect(top).toHaveLength(1);
});

test("recall with tagsMatch all_strict keeps only memories holding every tag", async () => {
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
	expect(await store.get(bank, "nope")).toBeNull();
});

test("list pages through memories and filters by tag", async () => {
	const page = await store.list(bank, { limit: 2, offset: 1 });
	expect(page.map((record) => record.text)).toEqual([
		"api tests run with bun test",
		"the web app uses react",
	]);
	const tagged = await store.list(bank, {
		tags: ["stack:docker"],
		tagsMatch: "any_strict",
		limit: 10,
		offset: 0,
	});
	expect(tagged).toHaveLength(1);
});

test("listTags counts tags per bank", async () => {
	const tags = await store.listTags(bank);
	expect(tags).toContainEqual({ tag: "project:api", count: 2 });
	expect(tags).toContainEqual({ tag: "project:web", count: 1 });
	expect(await store.listTags("generic")).toEqual([]);
});
