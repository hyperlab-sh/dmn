import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import type { Cue } from "../cue/cue.js";
import { FakeJudge } from "../judge/fake.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import type { MemoryRecord, RecallQuery } from "../store/types.js";
import { recall } from "./pipeline.js";

const config = loadConfig({
	env: { DMN_STORE_URL: "fake:", HOME: "/home/test" },
	configDir: "/nonexistent",
});
const now = new Date("2026-06-01T00:00:00Z");
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
	state = new LocalState({ directory, clock: () => now });
	recalled = [];
	for (const bank of ["org-acme", "org-initech", "generic"]) {
		await fake.retain(bank, [{ content: `memory in ${bank}`, tags: ["project:web"] }]);
	}
	await fake.retain("generic", [{ content: "memory dormant in generic", tags: ["project:web"] }]);
});

afterAll(() => {
	state.close();
	rmSync(directory, { recursive: true, force: true });
});

const texts = async (organization: string, prompt?: string) =>
	(
		await recall({
			store,
			state,
			config,
			cue: cueFor(organization),
			prompt,
			random: () => 0.5,
			now,
		})
	).map((memory) => memory.text);

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
	expect(result).toContain("memory in generic");
	expect(result).not.toContain("memory in org-acme");
	expect(result).not.toContain("memory in org-initech");
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

const gated = (extra: object) =>
	recall({
		store,
		state,
		config,
		cue: cueFor("acme"),
		prompt: "memory in",
		random: () => 0.5,
		now,
		...extra,
	});

test("the judge gate keeps what scores at or above the threshold, in activation order, and keeps an unanswered one", async () => {
	await fake.retain("generic", [
		{ content: "memory in extra one", tags: ["project:web"] },
		{ content: "memory in extra two", tags: ["project:web"] },
	]);
	const plain = await gated({});
	expect(plain.length).toBeGreaterThanOrEqual(4);
	const [first, second, third, fourth] = plain.map((memory) => memory.id) as [
		string,
		string,
		string,
		string,
	];
	// The fourth sits exactly on the threshold and stays.
	const judge = new FakeJudge({
		probabilities: { [first]: 0.9, [second]: 0.2, [fourth]: 0.5 },
		skip: [third],
	});
	const errors: unknown[] = [];
	const result = await gated({
		judge,
		judgeThreshold: 0.5,
		onJudgeError: (error: unknown) => errors.push(error),
	});
	expect(result.map((memory) => memory.id)).toEqual(
		plain.map((m) => m.id).filter((id) => id !== second),
	);
	expect(judge.calls).toBe(1);
	expect(errors).toHaveLength(1);
});

test("without a judge the result is unchanged and no judge is called", async () => {
	const judge = new FakeJudge();
	const plain = await gated({});
	// A judge without a threshold is not a gate either.
	expect(await gated({ judge })).toEqual(plain);
	expect(judge.calls).toBe(0);
});

test("a judge that throws leaves the list unfiltered and is reported once", async () => {
	const plain = await gated({});
	const errors: unknown[] = [];
	const result = await gated({
		judge: new FakeJudge({ failWith: new Error("judge down") }),
		judgeThreshold: 0.9,
		onJudgeError: (error: unknown) => errors.push(error),
	});
	expect(result).toEqual(plain);
	expect(errors).toHaveLength(1);
});

test("a prompt holding a secret is not sent to the judge", async () => {
	const judge = new FakeJudge();
	const result = await gated({ judge, judgeThreshold: 0.9, prompt: "key AKIAIOSFODNN7EXAMPLE" });
	expect(judge.calls).toBe(0);
	expect(result.length).toBeGreaterThan(0);
});
