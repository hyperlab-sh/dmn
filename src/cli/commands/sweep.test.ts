import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../../state/state.js";
import { startFakeServer } from "../../store/fake.js";
import { bankFor, HindsightStore } from "../../store/hindsight.js";
import { runSweep } from "./sweep.js";

const root = new URL("../../..", import.meta.url).pathname;

let server: ReturnType<typeof startFakeServer>;
let scratch: string;
let env: Record<string, string>;
let plain: string;
let decision: string;

/** Async spawn: the fake server lives in this process and must keep answering. */
async function dmn(...args: string[]) {
	const child = Bun.spawn(["bun", "src/cli/index.ts", "sweep", ...args], {
		cwd: root,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

function dormant(id: string): boolean {
	const state = new LocalState({ directory: join(scratch, "state", "dmn") });
	try {
		return state.isDormant(id);
	} finally {
		state.close();
	}
}

beforeAll(async () => {
	server = startFakeServer();
	scratch = mkdtempSync(join(tmpdir(), "dmn-sweep-cli-"));
	env = {
		PATH: process.env.PATH ?? "",
		HOME: scratch,
		DMN_STORE_URL: server.url,
		XDG_STATE_HOME: join(scratch, "state"),
		XDG_CONFIG_HOME: join(scratch, "config"),
		// Far in the future: everything seeded is old and unused.
		DMN_NOW: "2100-01-01T00:00:00Z",
	};
	const store = new HindsightStore({ baseUrl: server.url });
	await store.retain(bankFor(undefined), [
		{ content: "an unused note", tags: ["project:widgets"] },
		{ content: "a decision", tags: ["decision"] },
	]);
	const memories = await store.list(bankFor(undefined), { limit: 10, offset: 0 });
	plain = memories.find((memory) => memory.text === "an unused note")?.id as string;
	decision = memories.find((memory) => memory.text === "a decision")?.id as string;
});

afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("sweep --dry-run reports without writing; sweep marks dormant; --revive clears; unknown id exits 1", async () => {
	const dry = await dmn("--dry-run");
	expect(dry.exitCode).toBe(0);
	expect(dry.stdout).toContain("examined 2; would mark 1 dormant; kept 1 protected");
	expect(dry.stdout).toContain(`dormant ${plain}`);
	expect(dormant(plain)).toBe(false);

	const real = await dmn();
	expect(real.exitCode).toBe(0);
	expect(real.stdout).toContain("examined 2; marked 1 dormant; kept 1 protected");
	expect(real.stdout).toContain(`protected ${decision}`);
	expect(dormant(plain)).toBe(true);
	expect(dormant(decision)).toBe(false);

	// In-process, no spawn: a conflicting flag refuses and leaves the memory dormant.
	expect(await runSweep(["--revive", plain, "--dry-run"], env)).toBe(1);
	expect(await runSweep(["--revive", plain, "--bank", "generic"], env)).toBe(1);
	expect(dormant(plain)).toBe(true);

	const revived = await dmn("--revive", plain);
	expect(revived).toMatchObject({ stdout: `revived ${plain}\n`, exitCode: 0 });
	expect(dormant(plain)).toBe(false);

	const unknown = await dmn("--revive", "no-such-id");
	expect(unknown.exitCode).toBe(1);
	expect(unknown.stderr).toContain("no-such-id is not dormant");
});
