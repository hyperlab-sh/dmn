import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("hook command without DMN_STORE_URL exits 2 and names the variable on stderr", () => {
	const { DMN_STORE_URL: _ignored, ...env } = process.env;
	const result = Bun.spawnSync(["bun", "src/cli/index.ts", "hook", "user-prompt"], {
		env,
		cwd: new URL("../..", import.meta.url).pathname,
	});
	expect(result.exitCode).toBe(2);
	expect(result.stderr.toString()).toContain("DMN_STORE_URL");
});

test("hook stop without DMN_STORE_URL exits 1, which Claude Code does not read as a block", () => {
	const { DMN_STORE_URL: _ignored, ...env } = process.env;
	const result = Bun.spawnSync(["bun", "src/cli/index.ts", "hook", "stop"], {
		env,
		cwd: new URL("../..", import.meta.url).pathname,
	});
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("DMN_STORE_URL");
});

test("hook post-tool does no work: it never opens the state", () => {
	const directory = mkdtempSync(join(tmpdir(), "dmn-post-tool-"));
	try {
		const result = Bun.spawnSync(["bun", "src/cli/index.ts", "hook", "post-tool"], {
			env: {
				PATH: process.env.PATH ?? "",
				DMN_STORE_URL: "fake:",
				XDG_STATE_HOME: join(directory, "state"),
				XDG_CONFIG_HOME: join(directory, "config"),
			},
			cwd: new URL("../..", import.meta.url).pathname,
			stdin: Buffer.from('{"hook_event_name":"PostToolUse","cwd":"/","session_id":"s"}'),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(existsSync(join(directory, "state"))).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
