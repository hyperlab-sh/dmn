import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rosterModelId, rosterRoles, rosterSourceQuery } from "../../roster/roster.js";
import { LocalState } from "../../state/state.js";
import { startFakeServer } from "../../store/fake.js";
import { bankFor, HindsightStore } from "../../store/hindsight.js";

const root = new URL("../../..", import.meta.url).pathname;
const fixtures = join(root, "fixtures/hooks");
const seed = "11";

let server: ReturnType<typeof startFakeServer>;
let store: HindsightStore;
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
	fields: {
		cwd?: string;
		transcript?: string;
		stateHome?: string;
		/** Judge section of a private config for this run; `withKey` says whether to export one. */
		judge?: object;
		withKey?: boolean;
	} = {},
): Promise<Hook> {
	const input = readFileSync(join(fixtures, fixture), "utf8")
		.replace("__CWD__", fields.cwd ?? space)
		.replace("__TRANSCRIPT__", fields.transcript ?? join(fixtures, "transcript.jsonl"));
	const started = performance.now();
	const childEnv: Record<string, string> = { ...env };
	if (fields.stateHome) childEnv.XDG_STATE_HOME = fields.stateHome;
	if (fields.judge) {
		configCounter += 1;
		const configHome = join(scratch, `config-judge-${configCounter}`);
		mkdirSync(join(configHome, "dmn"), { recursive: true });
		writeFileSync(
			join(configHome, "dmn", "config.json"),
			JSON.stringify({ organizations: { acmeorg: "acme" }, judge: fields.judge }),
		);
		childEnv.XDG_CONFIG_HOME = configHome;
		if (fields.withKey !== false) childEnv.LAYA_API_KEY = "stub-key";
	}
	// Async spawn: the fake server lives in this process and must keep answering.
	const child = Bun.spawn(["bun", "src/cli/index.ts", "hook", sub], {
		cwd: root,
		env: childEnv,
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

let configCounter = 0;

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
	judgeCalls = 0;
	judgeStates = [];
	// The store server also answers the Laya batch API's kind question: a state citing memory
	// markers is a decision, a plain one a learning. One server, no second listener.
	server = startFakeServer({
		judgeBatch(requests) {
			judgeCalls += 1;
			judgeStates.push(...requests.map((item) => item.state));
			return requests.map((item) => ({
				answers: {
					kind: {
						type: "choice",
						choice: item.state.includes("[m:") ? "decision" : "learning",
						probabilities: { turn: 0.1, learning: 0.9, decision: 0.9 },
					},
				},
			}));
		},
	});
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

test("stop retains both turns kind-tagged by the judge, with the cue's tags, and counts no uncited or unknown memory", async () => {
	// Baselines, so this test passes whatever ran before it: only the delta is this test's.
	const callsBefore = judgeCalls;
	const statesBefore = judgeStates.length;
	const judged = await run("stop", "stop.json", {
		judge: { provider: "laya", baseUrl: server.url },
	});
	expect(judged).toMatchObject({ stdout: "", exitCode: 0, stderr: "" });
	// One batch call classified both retained texts.
	expect(judgeCalls - callsBefore).toBe(1);
	expect(judgeStates.slice(statesBefore)).toHaveLength(2);
	const turns = (await store.list(bankFor("acme"), { limit: 20, offset: 0 })).filter((memory) =>
		memory.tags.some((tag) => tag.startsWith("kind:")),
	);
	expect(turns).toHaveLength(2);
	// The stub classifies the turn citing markers as a decision, the plain one as a learning.
	expect(turns.find((turn) => turn.metadata?.speaker === "user")?.tags).toContain("kind:learning");
	expect(turns.find((turn) => turn.metadata?.speaker === "assistant")?.tags).toContain(
		"kind:decision",
	);
	for (const turn of turns) {
		expect(turn.tags).toEqual(
			expect.arrayContaining(["project:space", "role:unknown", "task:read"]),
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
	const callsBefore = judgeCalls;
	// This stop runs laya without a key: Stop never fails because of the judge — it warns and
	// retains kind:turn instead, and the judge stub is asked nothing.
	const noKey = await run("stop", "stop.json", {
		transcript,
		judge: { provider: "laya", baseUrl: server.url },
		withKey: false,
	});
	expect(noKey.exitCode).toBe(0);
	expect(noKey.stderr).toContain("LAYA_API_KEY");
	expect(judgeCalls).toBe(callsBefore);
	const after = await order(run("user-prompt", "user-prompt.json"));
	// All three seeded memories surface and the cited one is not yet on top; its exact starting
	// place follows the seed and the bank's contents (earlier tests may have retained more), so
	// only the lift the citation buys is pinned.
	expect(new Set(before)).toEqual(seeded);
	expect(before[0]).not.toBe(target);
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
	for (const transcript of [pair, pair]) {
		expect(await run("stop", "stop.json", { transcript, stateHome })).toMatchObject({
			exitCode: 0,
		});
	}
	// The last stop runs provider none with a key exported: the stub is asked nothing.
	const callsBefore = judgeCalls;
	const off = await run("stop", "stop.json", {
		transcript: one,
		stateHome,
		judge: { provider: "none", baseUrl: server.url },
	});
	expect(off.exitCode).toBe(0);
	expect(judgeCalls).toBe(callsBefore);
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

test("session start appends one roster line per other role after the memory lines", async () => {
	// Run last: its models stay out of the earlier session-start runs of this file.
	await store.retain(bankFor("acme"), [
		{
			content: "The reviewer cites the design doc for every change. It also tracks flaky tests.",
			tags: ["role:reviewer"],
		},
		{ content: "The developer keeps the build green.", tags: ["role:developer"] },
	]);
	for (const role of rosterRoles) {
		await store.createMentalModel(bankFor("acme"), {
			id: rosterModelId(role),
			name: rosterModelId(role),
			sourceQuery: rosterSourceQuery(role),
			tags: [`role:${role}`],
			maxTokens: 512,
		});
	}
	// An Edit in the transcript makes the cue's role developer: the reviewer is the other role.
	const developerTranscript = join(scratch, "developer.jsonl");
	writeFileSync(
		developerTranscript,
		JSON.stringify({
			type: "assistant",
			uuid: "a-developer",
			message: {
				role: "assistant",
				content: [{ type: "tool_use", name: "Edit", input: { file_path: "a" } }],
			},
		}),
	);
	const lines = injected(
		await run("session-start", "session-start.json", { transcript: developerTranscript }),
	);
	const roster = lines.filter((line) => line.startsWith("[roster:"));
	// One line for the reviewer's first sentence; none for the session's own role, none for
	// the roles whose models have nothing to say yet.
	expect(roster).toEqual(["[roster:reviewer] The reviewer cites the design doc for every change."]);
	// The roster lines come after the memory lines, which keep their marker shape.
	expect(lines.at(-1)).toBe(roster[0]);
	expect(lines.length).toBeGreaterThan(roster.length);
	expect(lines[0]).toMatch(/^\[m:/);
});
