import { expect, test } from "bun:test";

test("hook command without DMN_STORE_URL exits 2 and names the variable on stderr", () => {
	const { DMN_STORE_URL: _ignored, ...env } = process.env;
	const result = Bun.spawnSync(["bun", "src/cli/index.ts", "hook", "user-prompt"], {
		env,
		cwd: new URL("../..", import.meta.url).pathname,
	});
	expect(result.exitCode).toBe(2);
	expect(result.stderr.toString()).toContain("DMN_STORE_URL");
});
