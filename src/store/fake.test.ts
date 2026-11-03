import { afterAll, beforeAll, expect, test } from "bun:test";
import { startFakeServer } from "./fake.js";
import { HindsightStore, StoreError } from "./hindsight.js";
import type { MemoryRecord } from "./types.js";

const bank = "org-acme";
let server: ReturnType<typeof startFakeServer>;
let store: HindsightStore;
let recalled: MemoryRecord[];
let oddServer: ReturnType<typeof Bun.serve>;

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

beforeAll(() => {
	oddServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			if (request.url.endsWith("/memories/hang")) return new Promise<Response>(() => {});
			return Response.json({ id: "x", text: "no timestamp" });
		},
	});
});

afterAll(() => {
	server.stop();
	oddServer.stop(true);
});

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
	expect(await store.get(bank, "nope")).toBeNull();
});

test("list pages through memories and filters by tag", async () => {
	const page = await store.list(bank, { limit: 2, offset: 1 });
	expect(page.map((record) => record.text)).toEqual([
		"api tests run with bun test",
		"the web app uses react",
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

test("a wrong base URL is an error for list and listTags, not an empty store", async () => {
	const wrong = new HindsightStore({ baseUrl: `${server.url}/prefix` });
	await expect(wrong.list(bank, { limit: 1, offset: 0 })).rejects.toBeInstanceOf(StoreError);
	await expect(wrong.listTags(bank)).rejects.toBeInstanceOf(StoreError);
});

test("a hung store aborts at timeoutMs as a StoreError with status 0", async () => {
	const hung = new HindsightStore({ baseUrl: `http://127.0.0.1:${oddServer.port}`, timeoutMs: 50 });
	const error = await hung.get(bank, "hang").catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).status).toBe(0);
});

test("a record without any timestamp is a StoreError, not an empty createdAt", async () => {
	const odd = new HindsightStore({ baseUrl: `http://127.0.0.1:${oddServer.port}` });
	await expect(odd.get(bank, "x")).rejects.toThrow(/no timestamp/);
});
