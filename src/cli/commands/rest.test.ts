import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../../state/state.js";
import { startFakeServer } from "../../store/fake.js";
import { HindsightStore } from "../../store/hindsight.js";
import { runRestCommand } from "./rest.js";

const root = new URL("../../..", import.meta.url).pathname;
const bank = "org-acme";
const quietBank = "org-quiet";
const now = new Date("2026-06-01T00:00:00Z");

let server: ReturnType<typeof startFakeServer>;
let scratch: string;
let env: Record<string, string>;
let projectLearning: string;
let orgLearning: string;

/** Async spawn: the fake server lives in this process and must keep answering. */
async function dmn(...args: string[]) {
	const child = Bun.spawn(["bun", "src/cli/index.ts", "rest", ...args], {
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

beforeAll(async () => {
	server = startFakeServer();
	scratch = mkdtempSync(join(tmpdir(), "dmn-rest-cli-"));
	env = {
		PATH: process.env.PATH ?? "",
		HOME: scratch,
		DMN_STORE_URL: server.url,
		XDG_STATE_HOME: join(scratch, "state"),
		XDG_CONFIG_HOME: join(scratch, "config"),
		DMN_NOW: now.toISOString(),
	};
	const store = new HindsightStore({ baseUrl: server.url });
	await store.retain(bank, [
		{ content: "learning from project a", tags: ["project:a", "kind:learning"] },
		{ content: "learning without a project", tags: ["kind:learning"] },
		{ content: "learning used in one project only", tags: ["project:a", "kind:learning"] },
		{ content: "a turn, not a learning", tags: ["project:a", "kind:turn"] },
	]);
	await store.retain(quietBank, [{ content: "a quiet turn", tags: ["project:a", "kind:turn"] }]);
	const all = await store.list(bank, { limit: 10, offset: 0 });
	const idOf = (text: string) => all.find((memory) => memory.text === text)?.id as string;
	projectLearning = idOf("learning from project a");
	orgLearning = idOf("learning without a project");
	// The use records live in the state file the spawned CLI will open.
	const state = new LocalState({ directory: join(scratch, "state", "dmn"), clock: () => now });
	for (const id of [projectLearning, orgLearning]) {
		state.recordUse(id, "turn-1", "a");
		state.recordUse(id, "turn-2", "b");
	}
	state.recordUse(idOf("learning used in one project only"), "turn-1", "a");
	state.close();
});

afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("rest prints the report of every bank it was asked for; --apply prints what it promoted", async () => {
	// An unknown flag refuses without touching the store (in-process: no spawn needed).
	expect(await runRestCommand(["--nope"], env)).toBe(1);
	// A store that cannot be reached fails the bank and the exit (in-process; loopback refuses at once).
	expect(
		await runRestCommand(["--bank", "generic"], { ...env, DMN_STORE_URL: "http://127.0.0.1:1" }),
	).toBe(1);

	const report = await dmn("--bank", bank, "--bank", quietBank, "--bank", "org-never");
	expect(report).toMatchObject({ exitCode: 0, stderr: "" });
	expect(report.stdout).toContain("consolidated org-acme: 0 deduplicated\n");
	expect(report.stdout).toContain(
		`promote ${projectLearning} project → organization (projects: a, b)\n`,
	);
	expect(report.stdout).toContain(
		`promote ${orgLearning} organization → generic (projects: a, b)\n`,
	);
	expect(report.stdout).not.toContain("promoted ");
	expect(report.stdout).toContain(`no memory tagged kind:learning in ${quietBank}\n`);
	expect(report.stdout).toContain("skipped org-never: not found\n");

	const applied = await dmn("--apply", "--bank", bank);
	expect(applied).toMatchObject({ exitCode: 0, stderr: "" });
	expect(applied.stdout).toContain(`promoted ${projectLearning}\n`);
	expect(applied.stdout).toContain(`promoted ${orgLearning}\n`);
});
