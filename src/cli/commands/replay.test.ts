import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
let scratch: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-replay-cli-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const dmn = (...args: string[]) => {
	const { DMN_STORE_URL: _ignored, ...env } = process.env;
	return Bun.spawnSync(["bun", "src/cli/index.ts", ...args], {
		cwd: root,
		env: {
			...env,
			XDG_CONFIG_HOME: join(scratch, "config"),
			DMN_SEED: "7",
			DMN_NOW: "2026-06-03T00:00:00Z",
		},
	});
};

test("replay writes the report and judgements, then score fills the summary", () => {
	const out = join(scratch, "out");
	const run = dmn(
		"replay",
		"fixtures/replay/session-a.jsonl",
		"fixtures/replay/session-b.jsonl",
		"--store",
		"fake",
		"--out",
		out,
		"--top",
		"3",
	);
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	const [name] = readdirSync(out);
	const directory = join(out, name as string);
	expect(readdirSync(directory).sort()).toEqual(["judgements.json", "report.md"]);
	// DMN_NOW names the run; DMN_SEED fixes the noise.
	expect(name).toBe("run-2026-06-03T00-00-00-000Z");
	expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("noise=0.218");

	copyFileSync(
		join(root, "fixtures/replay/judgements.filled.json"),
		join(directory, "judgements.json"),
	);
	// No --top here: score reads the 3 the run was made with.
	const scored = dmn("replay", "score", directory);
	expect(scored.exitCode).toBe(0);
	expect(scored.stdout.toString()).toBe("store p@3 = 0.50\nactivation p@3 = 0.67\njudged 20/20\n");
});
