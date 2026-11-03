import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../../state/state.js";
import { startFakeServer } from "../../store/fake.js";
import { bankFor, HindsightStore } from "../../store/hindsight.js";

const root = new URL("../../..", import.meta.url).pathname;
const fixtures = join(root, "fixtures/hooks");

let server: ReturnType<typeof startFakeServer>;
let scratch: string;
let space: string;
let env: Record<string, string>;
let seeded: Set<string>;

async function postTool(
	fixture: string,
	toolUseId: string,
): Promise<{ stdout: string; exitCode: number }> {
	const input = readFileSync(join(fixtures, fixture), "utf8")
		.replace("__TOOL_USE_ID__", toolUseId)
		.replace("__CWD__", space)
		.replace("__TRANSCRIPT__", join(fixtures, "transcript.jsonl"));
	const started = performance.now();
	// Async spawn: the fake server lives in this process and must keep answering.
	const child = Bun.spawn(["bun", "src/cli/index.ts", "hook", "post-tool"], {
		cwd: root,
		env,
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	expect(performance.now() - started).toBeLessThan(2000);
	return { stdout, exitCode };
}

beforeAll(async () => {
	server = startFakeServer();
	scratch = mkdtempSync(join(tmpdir(), "dmn-post-tool-"));
	space = join(scratch, "workspace", "acmeorg", "space");
	mkdirSync(space, { recursive: true });
	writeFileSync(join(space, "HYPER.md"), "");
	mkdirSync(join(scratch, "config", "dmn"), { recursive: true });
	writeFileSync(
		join(scratch, "config", "dmn", "config.json"),
		JSON.stringify({
			organizations: { acmeorg: "acme" },
			intrusionThreshold: -5.75, // DMN_NOW is decades after the memories, so their activation is far below zero
			intrusionCooldown: 3,
		}),
	);
	env = {
		PATH: process.env.PATH ?? "",
		HOME: scratch,
		DMN_STORE_URL: server.url,
		XDG_STATE_HOME: join(scratch, "state"),
		XDG_CONFIG_HOME: join(scratch, "config"),
		// The seed of the decision table in intrude.test.ts: each call draws from its own tool_use_id.
		DMN_SEED: "24",
		DMN_NOW: "2100-01-01T00:00:00Z",
	};
	const store = new HindsightStore({ baseUrl: server.url });
	await store.retain(bankFor("acme"), [
		{ content: "Retry delays in the sync worker use jitter.", tags: ["project:space"] },
		{ content: "Sync worker retries are capped at five attempts.", tags: ["project:space"] },
		{ content: "The sync worker logs every retry delay.", tags: ["project:space"] },
	]);
	seeded = new Set(
		(await store.list(bankFor("acme"), { limit: 10, offset: 0 })).map((memory) => memory.id),
	);
});

afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("five tool calls with a cooldown of 3 surface one memory on the first and fifth, uncounted", async () => {
	// Read, Edit, Bash and an unrelated tool, then Read again.
	const calls = [
		"post-tool-read.json",
		"post-tool-edit.json",
		"post-tool-bash.json",
		"post-tool-other.json",
		"post-tool-read.json",
	];
	const outputs: string[] = [];
	for (const [index, fixture] of calls.entries()) {
		const hook = await postTool(fixture, `tool-${index + 1}`);
		expect(hook.exitCode).toBe(0);
		outputs.push(hook.stdout);
	}
	expect(outputs.map((stdout) => stdout !== "")).toEqual([true, false, false, false, true]);
	for (const stdout of [outputs[0], outputs[4]] as string[]) {
		const { hookSpecificOutput } = JSON.parse(stdout);
		expect(hookSpecificOutput.hookEventName).toBe("PostToolUse");
		const line: string = hookSpecificOutput.additionalContext;
		expect(line).not.toContain("\n");
		const id = /^\[m:([^\]]+)\] \S/.exec(line)?.[1];
		expect(seeded.has(id as string)).toBe(true);
	}

	const state = new LocalState({ directory: join(scratch, "state", "dmn") });
	try {
		// An emission restarts the cooldown, and surfacing is not use.
		expect(state.toolCallsSince("session-1")).toBe(0);
		for (const id of seeded) expect(state.uses(id).useCount).toBe(0);
	} finally {
		state.close();
	}
});
