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
import { run as runReplayCommand } from "./replay.js";

const root = new URL("../../..", import.meta.url).pathname;
let scratch: string;
let base: string;
let baseRun: { exitCode: number; stderr: string };

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
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Calls the command in-process, capturing what it writes to stderr (no spawn needed). */
async function inProcess(args: string[]): Promise<{ code: number; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk;
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runReplayCommand(args);
		return { code, stderr };
	} finally {
		process.stderr.write = original;
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
	expect(strayFlag.stderr).toContain("--uses and --measure-from need --as-live");
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
