import { describe, expect, test } from "bun:test";
import { HindsightStore } from "./hindsight.js";

const storeUrl = process.env.DMN_STORE_URL;

describe.skipIf(!storeUrl)("Hindsight contract (needs DMN_STORE_URL)", () => {
	test("retain three tagged items, recall by one tag, list tag counts", async () => {
		const store = new HindsightStore({
			baseUrl: storeUrl ?? "",
			timeoutMs: 30_000,
			retainTimeoutMs: 100_000,
		});
		const bank = `contract-${crypto.randomUUID().slice(0, 8)}`;
		const suffix = crypto.randomUUID().slice(0, 8);
		const tags = [`one:${suffix}`, `two:${suffix}`, `three:${suffix}`];
		await store.retain(bank, [
			{ content: "The deploy pipeline runs migrations before the release.", tags: [tags[0] ?? ""] },
			{ content: "The cache layer evicts entries after ten minutes.", tags: [tags[1] ?? ""] },
			{ content: "Retries use exponential backoff with jitter.", tags: [tags[2] ?? ""] },
		]);

		const found = await store.recall(bank, {
			query: "deploy pipeline migrations",
			tags: [tags[0] ?? ""],
			tagsMatch: "all_strict",
			topK: 10,
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBeString();
		expect(found[0]?.tags).toEqual([tags[0] ?? ""]);
		expect(found[0]?.score?.final).toBeNumber();

		const fetched = await store.get(bank, found[0]?.id ?? "");
		expect(fetched?.id).toBe(found[0]?.id ?? "");
		expect(fetched?.tags).toEqual([tags[0] ?? ""]);
		expect(await store.list(bank, { limit: 10, offset: 0 })).toHaveLength(3);

		const counts = await store.listTags(bank);
		for (const tag of tags) expect(counts).toContainEqual({ tag, count: 1 });
		const unwritten = `contract-unwritten-${suffix}`;
		expect(await store.listTags(unwritten)).toEqual([]);
		expect(await store.list(unwritten, { limit: 1, offset: 0 })).toEqual([]);
		expect(await store.recall(unwritten, { query: "x", topK: 1 })).toEqual([]);
		expect(await store.get(bank, "not-a-uuid")).toBeNull();
	}, 120_000);

	test("consolidate returns the store's operation id and deduplicated count", async () => {
		const store = new HindsightStore({ baseUrl: storeUrl ?? "", timeoutMs: 30_000 });
		const bank = `contract-consolidate-${crypto.randomUUID().slice(0, 8)}`;
		await store.retain(bank, [{ content: "The deploy pipeline runs migrations first.", tags: [] }]);
		const result = await store.consolidate(bank);
		expect(result.operationId).toBeString();
		expect(result.deduplicated).toBeNumber();
	}, 120_000);
});
