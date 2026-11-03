import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "dmn-install-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("install creates the settings file, and its parent directory, with the four dmn hooks", () => {
	const path = join(directory, "claude", "settings.json");
	const result = Bun.spawnSync(["bun", "src/cli/index.ts", "install", "--settings", path], {
		cwd: new URL("../../..", import.meta.url).pathname,
	});
	expect(result.exitCode).toBe(0);
	const { hooks } = JSON.parse(readFileSync(path, "utf8"));
	expect(hooks).toEqual({
		SessionStart: [{ hooks: [{ type: "command", command: "dmn hook session-start" }] }],
		UserPromptSubmit: [{ hooks: [{ type: "command", command: "dmn hook user-prompt" }] }],
		PostToolUse: [{ hooks: [{ type: "command", command: "dmn hook post-tool" }] }],
		Stop: [{ hooks: [{ type: "command", command: "dmn hook stop" }] }],
	});
});
