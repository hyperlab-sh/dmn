import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { FakeJudge } from "../judge/fake.js";
import { LocalState } from "../state/state.js";
import type { FakeStore } from "../store/fake.js";
import { readManifests } from "./manifests.js";
import { type Judgement, RunExistsError, writeReport } from "./report.js";
import { readSeedMemories, runReplay, seedFakeStore } from "./run.js";
import { promptsFrom } from "./transcript.js";

const fixture = (name: string) =>
	new URL(`../../fixtures/replay/${name}`, import.meta.url).pathname;
const now = new Date("2026-06-03T00:00:00Z");
const config = loadConfig({
	env: { DMN_STORE_URL: "fake:", HOME: "/home/test" },
	configDir: "/nonexistent",
});
const prompts = [
	...promptsFrom(fixture("session-a.jsonl")),
	...promptsFrom(fixture("session-b.jsonl")),
];

let scratch: string;
let state: LocalState;
let store: FakeStore;
let retained = 0;

/** A deterministic stream standing in for the seeded generator. */
function counter(): () => number {
	let n = 0;
	return () => {
		n += 1;
		return (n * 0.137) % 1;
	};
}

const replay = (manifests = readManifests(fixture("manifests"))) =>
	runReplay({ prompts, store, state, config, top: 5, random: counter(), now, manifests });

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-replay-test-"));
	state = new LocalState({ directory: join(scratch, "state"), clock: () => now });
	store = await seedFakeStore(readSeedMemories(fixture("memories.json")), now);
	const retain = store.retain.bind(store);
	store.retain = async (...args) => {
		retained += 1;
		return retain(...args);
	};
});

afterAll(() => {
	state.close();
	rmSync(scratch, { recursive: true, force: true });
});

test("report lists the cue, the excerpt and both top-5 lists; judgements are one null entry per shown memory", async () => {
	const result = await replay();
	const directory = join(scratch, "one");
	writeReport(result, directory);
	const report = readFileSync(join(directory, "report.md"), "utf8");
	const judgements = JSON.parse(
		readFileSync(join(directory, "judgements.json"), "utf8"),
	) as Judgement[];

	expect(result.entries).toHaveLength(prompts.length);
	expect(report).toContain("cue: (generic, none, typescript, developer, test)");
	expect(report).toContain("> Fix the failing parser test");
	expect(report).toContain("store:");
	expect(report).toMatch(
		/\d\. \S+ A=-?[\d.]+ \(B=-?[\d.]+ S=-?[\d.]+ noise=-?[\d.]+ assoc=-?[\d.]+\)/,
	);
	expect(report.trimEnd().endsWith("## Summary\n\nunscored")).toBe(true);

	const shown = result.entries.reduce(
		(sum, entry) => sum + entry.store.length + entry.activation.length,
		0,
	);
	expect(judgements).toHaveLength(shown);
	expect(judgements.every((judgement) => judgement.useful === null)).toBe(true);
	const memories = JSON.parse(readFileSync(join(directory, "memories.json"), "utf8"));
	const shownMemories = result.entries.flatMap((e) => [...e.store, ...e.activation]);
	expect(Object.keys(memories).sort()).toEqual([...new Set(shownMemories.map((m) => m.id))].sort());
	expect(memories[shownMemories[0]?.id as string]).toBe(shownMemories[0]?.text);
	const promptTexts = JSON.parse(readFileSync(join(directory, "prompts.json"), "utf8"));
	expect(promptTexts["1"]).toBe(prompts[0]?.text);
	const first = result.entries[1];
	expect(judgements).toContainEqual({
		prompt: 2,
		id: first?.activation[0]?.id as string,
		order: "activation",
		useful: null,
	});
	expect(
		result.entries.every((entry) => entry.store.length <= 5 && entry.activation.length <= 5),
	).toBe(true);
});

test("a long prompt is cut to 120 characters in the report", async () => {
	const long = "x".repeat(300);
	const result = await runReplay({
		prompts: [{ index: 0, text: long, cwd: "/home/dev/acme/widgets", recentTools: [], at: "" }],
		store,
		state,
		config,
		top: 5,
		random: counter(),
		now,
	});
	const directory = join(scratch, "long");
	writeReport(result, directory);
	const report = readFileSync(join(directory, "report.md"), "utf8");
	expect(report).toContain(`> ${"x".repeat(120)}\n`);
	expect(report).not.toContain("x".repeat(121));
});

test("a prompt holding a secret is not written to prompts.json", async () => {
	const secret = "api_key=abcdef123456";
	const at = (text: string) => ({
		index: 0,
		text,
		cwd: "/home/dev/acme/widgets",
		recentTools: [],
		at: "",
	});
	const result = await runReplay({
		prompts: [at(`fix the parser, ${secret}`), at("fix the parser")],
		store,
		state,
		config,
		top: 5,
		random: counter(),
		now,
	});
	const directory = join(scratch, "secret");
	writeReport(result, directory);
	expect(JSON.parse(readFileSync(join(directory, "prompts.json"), "utf8"))).toEqual({
		"2": "fix the parser",
	});
});

test("two runs with the same seed and clock write byte-identical files", async () => {
	for (const name of ["a", "b"]) writeReport(await replay(), join(scratch, name));
	for (const file of ["report.md", "judgements.json"]) {
		expect(readFileSync(join(scratch, "a", file), "utf8")).toBe(
			readFileSync(join(scratch, "b", file), "utf8"),
		);
	}
});

test("activation order differs from store order, and the harness never retains", async () => {
	const before = retained;
	const result = await replay();
	const differs = result.entries.some(
		(entry) =>
			entry.store.map((memory) => memory.id).join() !==
			entry.activation.map((memory) => memory.id).join(),
	);
	expect(differs).toBe(true);
	expect(retained).toBe(before);
});

test("without --manifests the stack is empty; with them it comes from the override", async () => {
	expect((await replay([])).entries[0]?.cue.stack).toEqual([]);
	expect((await replay()).entries[0]?.cue.stack).toEqual(["typescript"]);
});

test("a run directory that already exists is never overwritten", async () => {
	const result = await replay();
	const directory = join(scratch, "filled");
	writeReport(result, directory);
	writeFileSync(join(directory, "judgements.json"), "[]");
	expect(() => writeReport(result, directory)).toThrow(RunExistsError);
	expect(readFileSync(join(directory, "judgements.json"), "utf8")).toBe("[]");
});

test("with a judge every entry gains the gated third list, written with the judge's answer", async () => {
	const judge = new FakeJudge();
	const result = await runReplay({
		prompts,
		store,
		state,
		config,
		top: 5,
		random: counter(),
		now,
		manifests: readManifests(fixture("manifests")),
		gate: { judge, threshold: 0.5 },
	});
	// One batch per prompt; the activation list itself is the one a run without a judge makes.
	expect(judge.calls).toBe(prompts.length);
	expect(result.entries.map((entry) => entry.activation)).toEqual(
		(await replay()).entries.map((entry) => entry.activation),
	);
	for (const entry of result.entries) {
		for (const memory of entry.judged ?? []) {
			expect(entry.judgements?.[memory.id]?.useful).toBeGreaterThanOrEqual(0.5);
		}
	}
	const directory = join(scratch, "judged");
	writeReport(result, directory);
	const report = readFileSync(join(directory, "report.md"), "utf8");
	expect(report).toContain("activation+judge:");
	const judgements = JSON.parse(
		readFileSync(join(directory, "judgements.json"), "utf8"),
	) as Judgement[];
	const third = judgements.filter((entry) => entry.order === "activation+judge");
	expect(third.length).toBe(result.entries.reduce((sum, e) => sum + (e.judged?.length ?? 0), 0));
	expect(third.length).toBeGreaterThan(0);
	for (const entry of third) {
		expect(entry.useful).toBe(true);
		expect(entry.judge?.useful).toBeGreaterThanOrEqual(0.5);
	}
});

test("a run without a judge has no third list", async () => {
	const directory = join(scratch, "unjudged");
	writeReport(await replay(), directory);
	expect(readFileSync(join(directory, "report.md"), "utf8")).not.toContain("activation+judge");
	expect(readFileSync(join(directory, "judgements.json"), "utf8")).not.toContain(
		"activation+judge",
	);
});

test("the gate drops a candidate below the threshold and refills the top from the next one", async () => {
	const run = (top: number, gate?: { judge: FakeJudge; threshold: number }) =>
		runReplay({
			prompts,
			store,
			state,
			config,
			top,
			random: counter(),
			now,
			manifests: readManifests(fixture("manifests")),
			...(gate && { gate }),
		});
	const [a, b, c] = ((await run(3)).entries[0]?.activation ?? []).map((memory) => memory.id) as [
		string,
		string,
		string,
	];
	const judge = new FakeJudge({ probabilities: { [a]: 0.1, [b]: 0.9, [c]: 0.9 } });
	const [entry] = (await run(2, { judge, threshold: 0.5 })).entries;
	expect(entry?.activation.map((memory) => memory.id)).toEqual([a, b]);
	expect(entry?.judged?.map((memory) => memory.id)).toEqual([b, c]);
});
