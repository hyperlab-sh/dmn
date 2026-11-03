import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import type { Cue } from "../cue/cue.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import type { MemoryRecord, RecallQuery } from "../store/types.js";
import { recall } from "./pipeline.js";

const config = loadConfig({
	env: { DMN_STORE_URL: "fake:", HOME: "/home/test" },
	configDir: "/nonexistent",
});
const cueFor = (organization: string): Cue => ({
	organization,
	project: "web",
	stack: [],
	role: "developer",
	task: "test",
});

let directory: string;
let state: LocalState;
let recalled: string[];
let ids: Record<string, string>;
const fake = new FakeStore();
const store = {
	retain: fake.retain.bind(fake),
	get: fake.get.bind(fake),
	list: fake.list.bind(fake),
	listTags: fake.listTags.bind(fake),
	recall: (bank: string, query: RecallQuery): Promise<MemoryRecord[]> => {
		recalled.push(bank);
		return fake.recall(bank, query);
	},
};

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "dmn-recall-"));
	state = new LocalState({ directory });
	recalled = [];
	for (const bank of ["org-acme", "org-initech", "generic"]) {
		await fake.retain(bank, [{ content: `memory in ${bank}`, tags: ["project:web"] }]);
	}
	await fake.retain("generic", [{ content: "memory dormant in generic", tags: ["project:web"] }]);
	ids = {};
	for (const bank of ["org-acme", "org-initech", "generic"]) {
		const [record] = await fake.list(bank, { limit: 1, offset: 0 });
		ids[bank] = record?.id ?? "";
	}
});

afterAll(() => {
	state.close();
	rmSync(directory, { recursive: true, force: true });
});

const texts = async (organization: string, prompt?: string) =>
	(await recall({ store, state, config, cue: cueFor(organization), prompt, now: new Date() })).map(
		(memory) => memory.text,
	);

test("an organization cue queries exactly its bank and generic", async () => {
	recalled = [];
	const result = await texts("acme", "memory");
	expect(recalled.sort()).toEqual(["generic", "org-acme"]);
	expect(result).toContain("memory in org-acme");
	expect(result).toContain("memory in generic");
	expect(result).not.toContain("memory in org-initech");
});

test("a generic cue queries only generic", async () => {
	recalled = [];
	const result = await texts("generic");
	expect(recalled).toEqual(["generic"]);
	expect(result.every((text) => text.includes("generic"))).toBe(true);
});

test("a dormant memory never appears, even as the top store result", async () => {
	const [top] = await store.recall("generic", {
		query: "memory dormant in generic",
		topK: 1,
	});
	expect(top?.text).toBe("memory dormant in generic");
	state.setDormant(top?.id ?? "");
	const result = await texts("acme", "memory dormant in generic");
	expect(result).not.toContain("memory dormant in generic");
	expect(result).toContain("memory in generic");
});
