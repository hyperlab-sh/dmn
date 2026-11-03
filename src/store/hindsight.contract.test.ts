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

		const counts = await store.listTags(bank);
		for (const tag of tags) expect(counts).toContainEqual({ tag, count: 1 });
	}, 120_000);
});
