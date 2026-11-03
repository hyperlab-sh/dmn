import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
let scratch: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-replay-cli-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

test("replay writes the report and judgements, then score fills the summary", () => {
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
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	const [name] = readdirSync(out);
	const directory = join(out, name as string);
	expect(readdirSync(directory).sort()).toEqual([
		"judgements.json",
		"memories.json",
		"prompts.json",
		"report.md",
	]);
	// DMN_NOW names the run; DMN_SEED fixes the noise.
	expect(name).toBe("run-2026-06-03T00-00-00-000Z");
	expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("noise=0.218");

	copyFileSync(
		join(root, "fixtures/replay/judgements.filled.json"),
		join(directory, "judgements.json"),
	);
	// No --top here: score reads the 3 the run was made with.
	const scored = dmn(["replay", "score", directory]);
	expect(scored.exitCode).toBe(0);
	expect(scored.stdout.toString()).toBe("store p@3 = 0.50\nactivation p@3 = 0.67\njudged 20/20\n");
});

test("replay judge fills entries from the fake judge, annotates the report, and score runs after it", () => {
	const out = join(scratch, "judged");
	const files = ["fixtures/replay/session-a.jsonl", "fixtures/replay/session-b.jsonl"];
	dmn(["replay", ...files, "--store", "fake", "--out", out, "--top", "3"]);
	const directory = join(out, readdirSync(out)[0] as string);
	const secret = "laya-key-must-not-leak";

	const judged = dmn(["replay", "judge", directory, "--judge", "fake"], { LAYA_API_KEY: secret });
	expect(judged.stderr.toString()).toBe("");
	expect(judged.exitCode).toBe(0);
	const total = (JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8")) as unknown[])
		.length;
	expect(judged.stdout.toString()).toBe(`judged ${total}/${total}\n`);

	const entries = JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8"));
	type Entry = {
		prompt: number;
		id: string;
		order: string;
		useful: boolean;
		judge: { useful: number; level: number };
	};
	for (const entry of entries as Entry[]) {
		expect(entry.useful).toBe(entry.judge.useful >= 0.5);
		expect(entry.judge.level).toBeGreaterThanOrEqual(0);
		expect(entry.judge.level).toBeLessThanOrEqual(3);
	}
	// A memory shown in both orders of a prompt gets one answer, written to both entries.
	const both = (entries as Entry[]).filter((a) =>
		(entries as Entry[]).some((b) => b !== a && b.prompt === a.prompt && b.id === a.id),
	);
	expect(both.length).toBeGreaterThan(0);
	expect(entries.some((e: Entry) => e.useful)).toBe(true);
	expect(entries.some((e: Entry) => !e.useful)).toBe(true);
	const first = entries[0] as Entry;
	expect(readFileSync(join(directory, "report.md"), "utf8")).toContain(
		`${first.id} P(useful)=${first.judge.useful.toFixed(2)} `,
	);

	// --threshold moves `useful`, not the stored probability.
	const strict = dmn(["replay", "judge", directory, "--judge", "fake", "--threshold", "1.0"]);
	expect(strict.exitCode).toBe(0);
	const after = JSON.parse(readFileSync(join(directory, "judgements.json"), "utf8")) as Entry[];
	expect(after.map((e) => e.judge)).toEqual((entries as Entry[]).map((e) => e.judge));
	expect(after.every((e) => e.useful === e.judge.useful >= 1)).toBe(true);

	const scored = dmn(["replay", "score", directory]);
	expect(scored.exitCode).toBe(0);
	expect(scored.stdout.toString()).toMatch(
		new RegExp(
			`^store p@3 = \\d\\.\\d\\d\\nactivation p@3 = \\d\\.\\d\\d\\njudged ${total}/${total}\\n$`,
		),
	);
	for (const file of readdirSync(directory)) {
		expect(readFileSync(join(directory, file), "utf8")).not.toContain(secret);
	}
});

test("replay judge exits 2 without memories.json, without a configured judge, and without the key", () => {
	const out = join(scratch, "fresh");
	dmn(["replay", "fixtures/replay/session-a.jsonl", "--store", "fake", "--out", out]);
	const fresh = join(out, readdirSync(out)[0] as string);

	const none = dmn(["replay", "judge", fresh]);
	expect(none.exitCode).toBe(2);
	expect(none.stderr.toString()).toContain("no judge is configured");
	expect(none.stderr.toString()).toContain("--judge fake");

	const keyless = dmn(["replay", "judge", fresh, "--judge", "laya"]);
	expect(keyless.exitCode).toBe(2);
	expect(keyless.stderr.toString()).toContain("LAYA_API_KEY is not set");

	// A run made before this unit: only report.md and judgements.json.
	const old = join(scratch, "old");
	mkdirSync(old);
	for (const name of ["report.md", "judgements.json"])
		copyFileSync(join(fresh, name), join(old, name));
	expect(existsSync(join(old, "memories.json"))).toBe(false);
	const legacy = dmn(["replay", "judge", old, "--judge", "fake"]);
	expect(legacy.exitCode).toBe(2);
	expect(legacy.stderr.toString()).toContain("memories.json");
});
