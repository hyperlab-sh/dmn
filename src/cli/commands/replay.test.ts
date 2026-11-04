import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeServer } from "../../store/fake.js";
import { run as runReplayCommand } from "./replay.js";

const root = new URL("../../..", import.meta.url).pathname;
let scratch: string;
let base: string;
let baseRun: { exitCode: number; stderr: string };

// The walk-ladder fixture (D40): one fake Hindsight whose retains the tests can fail on
// demand, recording every document it was asked to retain. Cases change `failRetain` inside it.
let server: ReturnType<typeof startFakeServer>;
let failRetain: (documentId: string) => boolean = () => false;
const retainedDocuments: string[] = [];

const liveA = join(root, "fixtures/replay/live-a.jsonl");
const liveB = join(root, "fixtures/replay/live-b.jsonl");
const live0 = join(root, "fixtures/replay/live-0.jsonl");

const dmn = (args: string[], extraEnv: Record<string, string> = {}) => {
	const { DMN_STORE_URL: _ignored, ...env } = process.env;
	return Bun.spawnSync(["bun", "src/cli/index.ts", ...args], {
		cwd: root,
		env: {
			...env,
			XDG_CONFIG_HOME: join(scratch, "config"),
			DMN_SEED: "7",
			DMN_NOW: "2026-06-03T00:00:00Z",
			...extraEnv,
		},
	});
};

/** A private copy of the shared run, for a case that rewrites it. */
function copyOfBase(name: string): string {
	const directory = join(scratch, name);
	cpSync(base, directory, { recursive: true });
	return directory;
}

// One replay over the fixtures with the fake store; every case below reads or copies it.
beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-replay-cli-"));
	const out = join(scratch, "out");
	const run = dmn([
		"replay",
		"fixtures/replay/session-a.jsonl",
		"fixtures/replay/session-b.jsonl",
		"--store",
		"fake",
		"--out",
		out,
		"--top",
		"3",
	]);
	baseRun = { exitCode: run.exitCode, stderr: run.stderr.toString() };
	base = join(out, readdirSync(out)[0] as string);
	server = startFakeServer({
		failRetainOn: (body) => {
			retainedDocuments.push(...body.items.map((item) => item.document_id ?? ""));
			return body.items.some((item) => failRetain(item.document_id ?? ""));
		},
	});
});
afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

/** Calls the command in-process, capturing what it writes to stdout and stderr (no spawn). */
async function inProcess(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const touched = ["DMN_NOW", "DMN_SEED", "XDG_CONFIG_HOME", ...Object.keys(env)];
	const originals = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
	// The same environment the spawned cases get: a fixed clock and seed, a private config dir.
	process.env.DMN_NOW = "2026-06-03T00:00:00Z";
	process.env.DMN_SEED = "7";
	process.env.XDG_CONFIG_HOME = join(scratch, "config");
	Object.assign(process.env, env);
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	const writeOut = ((chunk: string | Uint8Array) => {
		stdout += chunk;
		return true;
	}) as typeof process.stdout.write;
	const writeErr = ((chunk: string | Uint8Array) => {
		stderr += chunk;
		return true;
	}) as typeof process.stderr.write;
	process.stdout.write = writeOut;
	process.stderr.write = writeErr;
	try {
		const code = await runReplayCommand(args);
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
		for (const key of touched) {
			if (originals[key] === undefined) delete process.env[key];
			else process.env[key] = originals[key];
		}
	}
}

test("--as-live exits 2 for a bad flag combination and a bad --measure-from, before any run", async () => {
	const transcripts = ["fixtures/replay/session-a.jsonl", "fixtures/replay/session-b.jsonl"];
	const noJudge = await inProcess(["--as-live", "--store", "fake", ...transcripts]);
	expect(noJudge.code).toBe(2);
	expect(noJudge.stderr).toContain("--as-live --uses judged needs --judge");

	const badDate = await inProcess([
		"--as-live",
		"--store",
		"fake",
		"--judge",
		"fake",
		"--measure-from",
		"not-a-date",
		...transcripts,
	]);
	expect(badDate.code).toBe(2);
	expect(badDate.stderr).toContain("--measure-from is not a date");

	const strayFlag = await inProcess(["--store", "fake", "--uses", "none", ...transcripts]);
	expect(strayFlag.code).toBe(2);
	expect(strayFlag.stderr).toContain(
		"--uses, --measure-from and --max-consecutive-failures need --as-live",
	);
});

test("--as-live exits 2 naming the file and index of a prompt without a timestamp", async () => {
	const untimed = join(scratch, "untimed.jsonl");
	writeFileSync(
		untimed,
		`${JSON.stringify({
			type: "user",
			cwd: "/home/dev/acme/widgets",
			message: { role: "user", content: "a prompt with no timestamp line" },
		})}\n`,
	);
	const { code, stderr } = await inProcess([
		"--as-live",
		"--store",
		"fake",
		"--judge",
		"fake",
		untimed,
	]);
	expect(code).toBe(2);
	// The file and the prompt's index, before anything is retained.
	expect(stderr).toContain("untimed.jsonl: prompt 0 has no timestamp");
});

test("--as-live --store fake starts from an empty store, not the seeded fixtures", async () => {
	const out = join(scratch, "as-live-out");
	const { code, stderr } = await inProcess([
		"--as-live",
		"--judge",
		"fake",
		"--store",
		"fake",
		"--out",
		out,
		join(root, "fixtures/replay/live-a.jsonl"),
		join(root, "fixtures/replay/live-b.jsonl"),
	]);
	expect(code).toBe(0);
	// The walk's only stderr is its progress lines (D40): no warning, no error.
	expect(stderr.split("\n").filter((line) => line && !line.startsWith("progress "))).toEqual([]);
	const report = readFileSync(join(out, "run-2026-06-03T00-00-00-000Z", "report.md"), "utf8");
	// The walk builds the store itself: nothing from fixtures/replay/memories.json is recalled.
	expect(report).not.toContain("Run the full test suite");
	// The first prompt of the day lists nothing at all — the store was empty when it ran.
	const first = report.slice(report.indexOf("### Prompt 1"), report.indexOf("### Prompt 2"));
	expect(first).toContain("store:\n\nactivation:\n");
});

test("replay writes the report and judgements, then score fills the summary", () => {
	expect(baseRun).toEqual({ exitCode: 0, stderr: "" });
	expect(readdirSync(base).sort()).toEqual([
		"judgements.json",
		"memories.json",
		"prompts.json",
		"report.md",
	]);
	// DMN_NOW names the run; DMN_SEED fixes the noise.
	expect(base.endsWith("run-2026-06-03T00-00-00-000Z")).toBe(true);
	expect(readFileSync(join(base, "report.md"), "utf8")).toContain("noise=0.218");

	const directory = copyOfBase("filled");
	copyFileSync(
		join(root, "fixtures/replay/judgements.filled.json"),
		join(directory, "judgements.json"),
	);
	// No --top here: score reads the 3 the run was made with.
	const scored = dmn(["replay", "score", directory]);
	expect(scored.exitCode).toBe(0);
	expect(scored.stdout.toString()).toBe("store p@3 = 0.50\nactivation p@3 = 0.67\njudged 20/20\n");
});

test("replay judge fills the run from the fake judge; a stricter threshold reuses the answers; score follows", () => {
	const directory = copyOfBase("judged");
	const secret = "laya-key-must-not-leak";
	const useful = () =>
		(
			JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8")) as { useful: boolean }[]
		).filter((entry) => entry.useful).length;

	const judged = dmn(["replay", "judge", directory, "--judge", "fake"], { LAYA_API_KEY: secret });
	expect(judged.stderr.toString()).toBe("");
	expect(judged.exitCode).toBe(0);
	expect(judged.stdout.toString()).toBe("judged 42/42\n");
	expect(useful()).toBe(14);
	const [first] = JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8"));
	expect(first.judge.useful).toBeCloseTo(3 / 7, 10);
	expect(first.judge.level).toBeCloseTo(9 / 7, 10);
	expect(first.useful).toBe(false);
	expect(readFileSync(join(directory, "report.md"), "utf8")).toContain(
		"1. 00000000-0000-4000-8000-000000000001 P(useful)=0.43 score=3 Run the full test suite",
	);

	expect(
		dmn(["replay", "judge", directory, "--judge", "fake", "--threshold", "1.0"]).exitCode,
	).toBe(0);
	expect(useful()).toBe(2);

	// The 1.0 threshold left two useful entries, so the scores follow it.
	const scored = dmn(["replay", "score", directory]);
	expect(scored.stdout.toString()).toBe("store p@3 = 0.05\nactivation p@3 = 0.05\njudged 42/42\n");
	for (const file of readdirSync(directory)) {
		expect(readFileSync(join(directory, file), "utf8")).not.toContain(secret);
	}
});

test("replay judge exits 2 with no judge configured, and for a run without memories.json", () => {
	const none = dmn(["replay", "judge", base]);
	expect(none.exitCode).toBe(2);
	expect(none.stderr.toString()).toContain("no judge is configured");
	expect(none.stderr.toString()).toContain("--judge fake");

	// A run made before this unit: only report.md and judgements.json.
	const old = join(scratch, "old");
	mkdirSync(old);
	for (const name of ["report.md", "judgements.json"])
		copyFileSync(join(base, name), join(old, name));
	const legacy = dmn(["replay", "judge", old, "--judge", "fake"]);
	expect(legacy.exitCode).toBe(2);
	expect(legacy.stderr.toString()).toContain("memories.json");
});

test("replay --judge fake writes the third order, already judged, and score prints three rows", () => {
	const out = join(scratch, "out-judged");
	const run = dmn([
		"replay",
		"fixtures/replay/session-a.jsonl",
		"fixtures/replay/session-b.jsonl",
		"--store",
		"fake",
		"--out",
		out,
		"--top",
		"3",
		"--judge",
		"fake",
	]);
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	const directory = join(out, readdirSync(out)[0] as string);
	expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("activation+judge:");
	const third = (
		JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8")) as {
			order: string;
			judge?: { useful: number; level: number };
		}[]
	).filter((entry) => entry.order === "activation+judge");
	expect(third.length).toBeGreaterThan(0);
	expect(third.every((entry) => entry.judge !== undefined)).toBe(true);

	const scored = dmn(["replay", "score", directory]).stdout.toString();
	expect(scored.split("\n").filter((line) => line.includes(" p@3 = "))).toHaveLength(3);
	expect(scored).toContain("activation+judge p@3 = ");
});

// The walk-ladder cases (D40) run against the file's fake server, each into its own --out under
// `scratch`; the first case below is one ladder scenario in three steps (stop, guards, resume).
const runDirectory = "run-2026-06-03T00-00-00-000Z";

/** One as-live invocation in-process against the fake server; `out` is under `scratch`. */
async function walk(args: string[], out: string) {
	return await inProcess(
		["--as-live", "--judge", "fake", "--store", server.url, "--out", out, ...args],
		{ DMN_STORE_URL: server.url },
	);
}

/** Reads a file of a run directory under `out`. */
const read = (out: string, name: string) => readFileSync(join(out, runDirectory, name), "utf8");

test("--max-consecutive-failures stops the walk; the guards hold; a rerun into the same --out resumes it", async () => {
	const out = join(scratch, "ladder");
	// Step 1 (AC 1): the interrupted walk. a0 and b0 seed (before 09:45); from live-a#1 on the
	// store rejects every retain.
	failRetain = (documentId) => /^live-a\.jsonl:[12]:/.test(documentId);
	const beforeStop = retainedDocuments.length;
	const stopped = await walk(
		["--measure-from", "2026-01-02T09:45:00Z", "--max-consecutive-failures", "2", liveA, liveB],
		out,
	);
	failRetain = () => false;
	// Exactly two failing prompts in a row — live-a#1 and live-a#2 — so the store's retain is
	// called for those two and never for the prompt after (live-b#1).
	expect(retainedDocuments.slice(beforeStop).sort()).toEqual([
		"live-a.jsonl:0:assistant",
		"live-a.jsonl:0:user",
		"live-a.jsonl:1:assistant",
		"live-a.jsonl:1:user",
		"live-a.jsonl:2:assistant",
		"live-a.jsonl:2:user",
		"live-b.jsonl:0:assistant",
		"live-b.jsonl:0:user",
	]);
	expect(stopped.code).toBe(1);
	// One stderr line names the count and the last error (the walk's own retain warnings beside it).
	const stopLines = stopped.stderr
		.split("\n")
		.filter((line) => line.includes("consecutive failures"));
	expect(stopLines).toHaveLength(1);
	expect(stopLines[0]).toContain("dmn: stopped after 2 consecutive failures: ");
	expect(stopLines[0]).toContain("500");
	expect(stopped.stderr).toContain("retain failed live-a.jsonl#1:");
	expect(stopped.stderr).toContain("retain failed live-a.jsonl#2:");
	// The report covers exactly the prompts measured before the stop (a1, a2) and the two seeds.
	expect(read(out, "report.md")).toContain("seeded: 2");
	expect(read(out, "report.md")).toContain("> How do I run the widgets parser tests?");
	expect(read(out, "report.md")).toContain("> Why does the widgets parser build fail?");
	expect(read(out, "report.md")).not.toContain("### Prompt 3");
	// The checkpoint holds what the next run resumes from (D40).
	const stoppedCheckpoint = JSON.parse(readFileSync(join(out, "checkpoint.json"), "utf8"));
	expect(stoppedCheckpoint.seeded).toEqual(["live-a.jsonl:0", "live-b.jsonl:0"]);
	expect(stoppedCheckpoint.measured).toEqual(["live-a.jsonl:1", "live-a.jsonl:2"]);
	expect(stoppedCheckpoint.entries).toHaveLength(2);
	expect(stoppedCheckpoint.lastAt).toBe("2026-01-03T11:00:00.000Z");
	expect(stoppedCheckpoint.settings).toEqual({
		measureFrom: "2026-01-02T09:45:00.000Z",
		uses: "judged",
		top: 5,
	});

	// Step 2 (AC 3): the guards. A run directory with no checkpoint (a plain run's --out):
	// still never overwritten.
	const plain = join(scratch, "plain-out");
	mkdirSync(join(plain, runDirectory), { recursive: true });
	const exists = await walk([liveA], plain);
	expect(exists.code).toBe(2);
	expect(exists.stderr).toContain("exists; pass another --out or remove it");
	// The checkpoint above was made with --measure-from 2026-01-02T09:45:00Z, --uses judged and
	// --top 5: anything else is refused before a single turn is retained.
	const beforeGuards = retainedDocuments.length;
	for (const other of [
		["--measure-from", "2026-01-02T10:30:00Z"],
		["--uses", "none"],
		["--top", "4"],
	]) {
		const mismatched = await walk([...other, liveA, liveB], out);
		expect(mismatched.code).toBe(2);
		expect(mismatched.stderr).toContain("the checkpoint in");
	}
	expect(retainedDocuments.length).toBe(beforeGuards);

	// Step 3 (AC 2): the resume, against a store that works again.
	const beforeResume = retainedDocuments.length;
	const resumed = await walk(["--measure-from", "2026-01-02T09:45:00Z", liveA, liveB], out);
	expect(resumed.code).toBe(0);
	// Never a retain for a checkpointed prompt: only live-b#1's turns are asked for.
	expect(retainedDocuments.slice(beforeResume).sort()).toEqual([
		"live-b.jsonl:1:assistant",
		"live-b.jsonl:1:user",
	]);
	// And never a recall either: no fourth entry, no recall-failure warning, and the report's
	// entries are the union in timestamp order (a1, a2, b1).
	expect(resumed.stderr).not.toContain("recall failed");
	const timestamps = [...read(out, "report.md").matchAll(/^### Prompt \d+ \(([^)]+)\)$/gm)].map(
		(match) => match[1],
	);
	expect(timestamps).toEqual([
		"2026-01-02T10:00:00.000Z",
		"2026-01-03T11:00:00.000Z",
		"2026-03-10T09:00:00.000Z",
	]);
	expect(read(out, "report.md")).toContain("> The widgets parser build fails again");
	// The seeded count is the total over both runs (D40).
	expect(read(out, "report.md")).toContain("seeded: 2");
	const resumedCheckpoint = JSON.parse(readFileSync(join(out, "checkpoint.json"), "utf8"));
	expect(resumedCheckpoint.measured).toHaveLength(3);
	expect(resumedCheckpoint.lastAt).toBe("2026-03-10T09:00:00.000Z");
});

test("a resumed walk that retains an older prompt warns once per prompt", async () => {
	const out = join(scratch, "older");
	const flags = ["--uses", "none", "--measure-from", "2026-01-01T00:00:00Z"] as const;
	const first = await walk([...flags, liveA, liveB], out);
	expect(first.code).toBe(0);
	// The rerun adds a transcript older than the last checkpointed prompt (b1, 2026-03-10).
	const before = retainedDocuments.length;
	const second = await walk([...flags, live0, liveA, liveB], out);
	expect(second.code).toBe(0);
	// The older prompts are retained (seeded); no checkpointed prompt is retained again.
	expect(retainedDocuments.slice(before).sort()).toEqual([
		"live-0.jsonl:0:assistant",
		"live-0.jsonl:0:user",
		"live-0.jsonl:1:assistant",
		"live-0.jsonl:1:user",
	]);
	// Exactly one warning per live-0 prompt, naming transcript, index and both timestamps.
	const expected = [
		"dmn: out of order: live-0.jsonl#0 (2025-12-31T09:00:00.000Z) is older than the checkpoint (2026-03-10T09:00:00.000Z); measurements before it did not see it",
		"dmn: out of order: live-0.jsonl#1 (2025-12-31T10:00:00.000Z) is older than the checkpoint (2026-03-10T09:00:00.000Z); measurements before it did not see it",
	];
	expect(second.stderr.split("\n").filter((line) => line.startsWith("dmn: out of order:"))).toEqual(
		expected,
	);
	// The report carries the warnings (the lead reads it to judge a rung, D40).
	const report = read(out, "report.md");
	expect(report.match(/^- out of order: /gm)).toHaveLength(2);
	// Both older prompts fall before --measure-from: retained (seeded), measured none of them.
	expect(report).toContain("seeded: 2");
	const entryTimes = [...report.matchAll(/^### Prompt \d+ \(([^)]+)\)$/gm)].map(
		(match) => match[1] as string,
	);
	expect(entryTimes).toHaveLength(5);
	expect(entryTimes.every((time) => time > "2026-01-01")).toBe(true);
});

test("the walk prints a progress line every 25 prompts and at each transcript boundary", async () => {
	// One 26-prompt transcript and a 3-prompt one after it, generated into the temp dir.
	const exchange = (at: string, number: number) =>
		`${[
			JSON.stringify({
				type: "user",
				cwd: "/home/dev/acme/widgets",
				timestamp: at,
				message: { role: "user", content: `Generated prompt number ${number}` },
			}),
			JSON.stringify({
				type: "assistant",
				cwd: "/home/dev/acme/widgets",
				timestamp: at,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Answer to generated prompt number ${number}` }],
				},
			}),
		].join("\n")}\n`;
	const at = (minutes: number) =>
		new Date(Date.parse("2026-04-01T09:00:00.000Z") + minutes * 60_000).toISOString();
	const long = join(scratch, "gen-long.jsonl");
	writeFileSync(
		long,
		Array.from({ length: 26 }, (_, index) => exchange(at(index * 10), index)).join(""),
	);
	const tail = join(scratch, "gen-tail.jsonl");
	writeFileSync(
		tail,
		Array.from({ length: 3 }, (_, index) => exchange(at(300 + index * 10), 26 + index)).join(""),
	);
	const run = await inProcess(
		[
			"--as-live",
			"--uses",
			"none",
			"--store",
			"fake",
			"--out",
			join(scratch, "progress"),
			long,
			tail,
		],
		{ DMN_STORE_URL: "fake:" },
	);
	expect(run.code).toBe(0);
	// At prompt 25, at the 26th (the long transcript's boundary) and at 29 (the tail's).
	const lines = run.stderr.split("\n").filter((line) => line.startsWith("progress "));
	expect(lines).toHaveLength(3);
	expect(lines[0]).toMatch(
		/^progress 25\/29 prompts, 0 seeded, 25 measured, 0 failed, \d+:\d+ elapsed$/,
	);
	expect(lines[1]).toMatch(
		/^progress 26\/29 prompts, 0 seeded, 26 measured, 0 failed, \d+:\d+ elapsed$/,
	);
	expect(lines[2]).toMatch(
		/^progress 29\/29 prompts, 0 seeded, 29 measured, 0 failed, \d+:\d+ elapsed$/,
	);
});
