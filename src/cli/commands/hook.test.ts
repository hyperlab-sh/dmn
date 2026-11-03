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
let judgeStub: ReturnType<typeof Bun.serve>;
let judgeCalls: number;
let judgeStates: string[];
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
	fields: { cwd?: string; transcript?: string; stateHome?: string } = {},
): Promise<Hook> {
	const input = readFileSync(join(fixtures, fixture), "utf8")
		.replace("__CWD__", fields.cwd ?? space)
		.replace("__TRANSCRIPT__", fields.transcript ?? join(fixtures, "transcript.jsonl"));
	const started = performance.now();
	// Async spawn: the fake server lives in this process and must keep answering.
	const child = Bun.spawn(["bun", "src/cli/index.ts", "hook", sub], {
		cwd: root,
		env: fields.stateHome ? { ...env, XDG_STATE_HOME: fields.stateHome } : env,
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

/** Writes a one-turn transcript whose assistant text is `text`; returns its path. */
function transcriptFor(name: string, text: string): string {
	const path = join(scratch, name);
	writeFileSync(
		path,
		[
			{
				type: "user",
				uuid: `u-${name}`,
				message: { role: "user", content: "What did we decide?" },
			},
			{
				type: "assistant",
				uuid: `a-${name}`,
				message: { role: "assistant", content: [{ type: "text", text }] },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	return path;
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
	judgeCalls = 0;
	judgeStates = [];
	// Answers the Laya batch API's kind question: a state that names jitter is a learning.
	judgeStub = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { requests: { state: string }[] };
			judgeCalls += 1;
			judgeStates.push(...body.requests.map((item) => item.state));
			return Response.json({
				results: body.requests.map((item) => ({
					answers: {
						kind: {
							type: "choice",
							choice: item.state.includes("jitter") ? "learning" : "decision",
							probabilities: { turn: 0.1, learning: 0.9, decision: 0.9 },
						},
					},
				})),
			});
		},
	});
});

afterAll(() => {
	server.stop();
	judgeStub.stop(true);
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
	const transcript = transcriptFor("cited.jsonl", `As [m:${target}] says.`);
	await run("stop", "stop.json", { transcript });
	const after = await order(run("user-prompt", "user-prompt.json"));
	// Pinned: under DMN_SEED and DMN_NOW the cited memory starts second.
	expect(before).toEqual([
		ids["Retry delays in the sync worker use jitter."],
		target,
		ids["The sync worker logs every retry delay."],
	]);
	expect(after[0]).toBe(target);
	// Use stamps follow DMN_NOW, the same clock recall ranks with.
	const state = new LocalState({ directory: join(scratch, "state", "dmn") });
	try {
		expect(state.uses(target).lastUsedAt).toBe("2100-01-01T00:00:00.000Z");
	} finally {
		state.close();
	}
});

test("stop records a co-use edge for two cited memories once, and none for one", async () => {
	const [a, b] = [
		ids["Retry delays in the sync worker use jitter."],
		ids["The sync worker logs every retry delay."],
	] as [string, string];
	// Its own state directory: the rank-pinning test above must not see these uses or edges.
	const stateHome = join(scratch, "state-co-use");
	const pair = transcriptFor("pair.jsonl", `Both [m:${a}] and [m:${b}] apply.`);
	const one = transcriptFor("one.jsonl", `Only [m:${a}].`);
	for (const transcript of [pair, pair, one]) {
		expect(await run("stop", "stop.json", { transcript, stateHome })).toMatchObject({
			exitCode: 0,
		});
	}
	const state = new LocalState({ directory: join(stateHome, "dmn") });
	try {
		const [low, high] = [a, b].sort() as [string, string];
		expect(state.associations(low)).toEqual([{ id: high, weight: 1 }]);
		expect(state.associationFan(a)).toBe(1);
		// The repeated pair stop counted no extra use: pair turn + one-id turn for a, pair turn for b.
		expect(state.uses(a).useCount).toBe(2);
		expect(state.uses(b).useCount).toBe(1);
	} finally {
		state.close();
	}
});

/** Writes a two-turn transcript and runs `dmn hook stop` over it with `judge` in the config. */
async function stopWithJudge(
	name: string,
	judge: object,
	user: string,
	assistant: string,
	key?: string,
): Promise<Hook> {
	const configHome = join(scratch, `config-${name}`);
	mkdirSync(join(configHome, "dmn"), { recursive: true });
	writeFileSync(
		join(configHome, "dmn", "config.json"),
		JSON.stringify({ organizations: { acmeorg: "acme" }, judge }),
	);
	const transcript = join(scratch, `${name}.jsonl`);
	writeFileSync(
		transcript,
		[
			{ type: "user", uuid: `u-${name}`, message: { role: "user", content: user } },
			{
				type: "assistant",
				uuid: `a-${name}`,
				message: { role: "assistant", content: [{ type: "text", text: assistant }] },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	const input = readFileSync(join(fixtures, "stop.json"), "utf8")
		.replace("__CWD__", space)
		.replace("__TRANSCRIPT__", transcript);
	const started = performance.now();
	const child = Bun.spawn(["bun", "src/cli/index.ts", "hook", "stop"], {
		cwd: root,
		env: { ...env, XDG_CONFIG_HOME: configHome, ...(key ? { LAYA_API_KEY: key } : {}) },
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode, elapsed: performance.now() - started };
}

test("stop with a judge: laya tags the stub's kinds, a missing key warns and keeps kind:turn, none asks nothing", async () => {
	const stubUrl = `http://localhost:${judgeStub.port}`;
	const kindOf = async (text: string) =>
		(await store.list(bankFor("acme"), { limit: 100, offset: 0 }))
			.find((memory) => memory.text === text)
			?.tags.at(-1);

	const tagged = await stopWithJudge(
		"stop-judge-laya",
		{ provider: "laya", baseUrl: stubUrl },
		"How should the worker retry, decided once and for all?",
		"It retries with jitter, capped at five attempts.",
		"stub-key",
	);
	expect(tagged).toMatchObject({ stdout: "", exitCode: 0, stderr: "" });
	expect(await kindOf("How should the worker retry, decided once and for all?")).toBe(
		"kind:decision",
	);
	expect(await kindOf("It retries with jitter, capped at five attempts.")).toBe("kind:learning");
	// One batch call, both retained texts, the key on the wire.
	expect(judgeCalls).toBe(1);
	expect(judgeStates).toHaveLength(2);
	expect(judgeStates[0]).toContain("decided once and for all");

	const noKey = await stopWithJudge(
		"stop-judge-nokey",
		{ provider: "laya", baseUrl: stubUrl },
		"And the log format?",
		"It stays newline-delimited JSON.",
	);
	expect(noKey.exitCode).toBe(0);
	expect(noKey.stderr).toContain("dmn:");
	expect(noKey.stderr).toContain("LAYA_API_KEY");
	expect(await kindOf("And the log format?")).toBe("kind:turn");
	expect(await kindOf("It stays newline-delimited JSON.")).toBe("kind:turn");
	expect(judgeCalls).toBe(1);

	const off = await stopWithJudge(
		"stop-judge-none",
		{ provider: "none", baseUrl: stubUrl },
		"Where does the local state live?",
		"In one SQLite file next to the config.",
		"stub-key",
	);
	expect(off).toMatchObject({ stdout: "", exitCode: 0, stderr: "" });
	expect(await kindOf("Where does the local state live?")).toBe("kind:turn");
	expect(await kindOf("In one SQLite file next to the config.")).toBe("kind:turn");
	expect(judgeCalls).toBe(1);
});
