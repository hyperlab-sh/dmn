import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCue } from "./cue.js";
import { scanCueInput } from "./scan.js";

let repository: string;

beforeAll(() => {
	repository = mkdtempSync(join(tmpdir(), "dmn-repo-"));
	for (const args of [
		["init", "--quiet"],
		["remote", "add", "origin", "https://user:token@github.com/acme/widgets.git"],
	]) {
		const result = Bun.spawnSync(["git", "-C", repository, ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
});

afterAll(() => rmSync(repository, { recursive: true, force: true }));

test("the origin URL of a real repository loses its userinfo before it reaches the cue", () => {
	const input = scanCueInput({ cwd: repository, organizations: {} });
	expect(input.originUrl).toBe("https://github.com/acme/widgets.git");
	expect(input.originUrl).not.toContain("token");
	expect(buildCue(input)).toMatchObject({ organization: "acme", project: "widgets" });
});
