import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../../state/state.js";
import { startFakeServer } from "../../store/fake.js";
import { bankFor, HindsightStore } from "../../store/hindsight.js";

const root = new URL("../../..", import.meta.url).pathname;
const fixtures = join(root, "fixtures/hooks");
const seed = "11";

let server: ReturnType<typeof startFakeServer>;
let store: HindsightStore;
let scratch: string;
let space: string;
let emptyDirectory: string;
let env: Record<string, string>;
let ids: Record<string, string>;

type Hook = { stdout: string; stderr: string; exitCode: number; elapsed: number };

/** Runs `dmn hook <sub>` with a fixture as stdin; `__CWD__` and `__TRANSCRIPT__` are filled in. */
async function run(
	sub: string,
	fixture: string,
	fields: { cwd?: string; transcript?: string } = {},
): Promise<Hook> {
	const input = readFileSync(join(fixtures, fixture), "utf8")
		.replace("__CWD__", fields.cwd ?? space)
		.replace("__TRANSCRIPT__", fields.transcript ?? join(fixtures, "transcript.jsonl"));
	const started = performance.now();
	// Async spawn: the fake server lives in this process and must keep answering.
	const child = Bun.spawn(["bun", "src/cli/index.ts", "hook", sub], {
		cwd: root,
		env,
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const elapsed = performance.now() - started;
	expect(elapsed).toBeLessThan(2000);
	return { stdout, stderr, exitCode, elapsed };
}

const injected = (hook: Hook): string[] => {
	expect(hook.exitCode).toBe(0);
	const output = JSON.parse(hook.stdout);
	return output.hookSpecificOutput.additionalContext.split("\n");
};
const markerIds = (lines: string[]) => lines.map((line) => /^\[m:([^\]]+)\]/.exec(line)?.[1]);

beforeAll(async () => {
	server = startFakeServer();
	scratch = mkdtempSync(join(tmpdir(), "dmn-hook-"));
	space = join(scratch, "workspace", "acmeorg", "space");
	emptyDirectory = join(scratch, "workspace", "elsewhere");
	mkdirSync(space, { recursive: true });
	mkdirSync(emptyDirectory, { recursive: true });
	writeFileSync(join(space, "HYPER.md"), "");
	mkdirSync(join(scratch, "config", "dmn"), { recursive: true });
	writeFileSync(
		join(scratch, "config", "dmn", "config.json"),
		JSON.stringify({ organizations: { acmeorg: "acme" } }),
	);
	env = {
		PATH: process.env.PATH ?? "",
		HOME: scratch,
		DMN_STORE_URL: server.url,
		XDG_STATE_HOME: join(scratch, "state"),
		XDG_CONFIG_HOME: join(scratch, "config"),
		DMN_SEED: seed,
		// Fixed far in the future: every age is about the same, so only noise and uses rank.
		DMN_NOW: "2100-01-01T00:00:00Z",
	};
	store = new HindsightStore({ baseUrl: server.url });
	await store.retain(bankFor("acme"), [
		{ content: "Retry delays in the sync worker use jitter.", tags: ["project:space"] },
		{ content: "Sync worker retries are capped at five attempts.", tags: ["project:space"] },
		{ content: "The sync worker logs every retry delay.", tags: ["project:space"] },
	]);
	ids = {};
	for (const memory of await store.list(bankFor("acme"), { limit: 10, offset: 0 })) {
		ids[memory.text] = memory.id;
	}
});

afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("session-start injects the organization's memories with their markers", async () => {
	const lines = injected(await run("session-start", "session-start.json"));
	expect(lines).toHaveLength(3);
	for (const line of lines) expect(line).toMatch(/^\[m:[0-9a-f-]{36}\] /);
});

test("user-prompt injects, and prints nothing when no memory matches", async () => {
	const lines = injected(await run("user-prompt", "user-prompt.json"));
	const seeded = new Set(Object.values(ids));
	expect(new Set(markerIds(lines).filter((id) => seeded.has(id as string)))).toEqual(seeded);

	const empty = await run("user-prompt", "user-prompt.json", { cwd: emptyDirectory });
	expect(empty).toMatchObject({ stdout: "", exitCode: 0 });
});

test("post-tool prints nothing", async () => {
	expect(await run("post-tool", "post-tool.json")).toMatchObject({ stdout: "", exitCode: 0 });
});

test("stop retains both turns with the cue's tags and counts no uncited or unknown memory", async () => {
	expect(await run("stop", "stop.json")).toMatchObject({ stdout: "", exitCode: 0 });
	const turns = (await store.list(bankFor("acme"), { limit: 20, offset: 0 })).filter((memory) =>
		memory.tags.includes("kind:turn"),
	);
	expect(turns).toHaveLength(2);
	for (const turn of turns) {
		expect(turn.tags).toEqual(
			expect.arrayContaining(["project:space", "role:unknown", "task:read", "kind:turn"]),
		);
	}
	expect(turns.map((turn) => turn.metadata?.speaker).sort()).toEqual(["assistant", "user"]);
	// DMN_NOW reaches the hook as its clock.
	for (const turn of turns) expect(turn.metadata?.retained_at).toBe("2100-01-01T00:00:00.000Z");
	expect(turns.map((turn) => turn.text).join("\n")).toContain("Add jitter to the retry delay");

	const state = new LocalState({ directory: join(scratch, "state", "dmn") });
	try {
		// The fixture cites a1 and b2, which the store does not know: made-up markers earn nothing.
		expect(state.uses("a1").useCount).toBe(0);
		expect(state.uses("b2").useCount).toBe(0);
		// The seeded memories were injected by earlier runs and not cited: surfacing is not use.
		for (const id of Object.values(ids)) expect(state.uses(id).useCount).toBe(0);
	} finally {
		state.close();
	}
});

test("a memory cited at stop ranks above the others on the next prompt", async () => {
	const seeded = new Set(Object.values(ids));
	const order = async (hook: Promise<Hook>) =>
		markerIds(injected(await hook)).filter((id) => seeded.has(id as string));
	const before = await order(run("user-prompt", "user-prompt.json"));
	const target = ids["Sync worker retries are capped at five attempts."] as string;
	const transcript = join(scratch, "cited.jsonl");
	writeFileSync(
		transcript,
		[
			{ type: "user", uuid: "u-x", message: { role: "user", content: "What did we decide?" } },
			{
				type: "assistant",
				uuid: "a-x",
				message: { role: "assistant", content: [{ type: "text", text: `As [m:${target}] says.` }] },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	await run("stop", "stop.json", { transcript });
	const after = await order(run("user-prompt", "user-prompt.json"));
	// Pinned: under DMN_SEED and DMN_NOW the cited memory starts second.
	expect(before).toEqual([
		ids["Retry delays in the sync worker use jitter."],
		target,
		ids["The sync worker logs every retry delay."],
	]);
	expect(after[0]).toBe(target);
});
