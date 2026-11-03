import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { FakeJudge } from "../judge/fake.js";
import type { Classification, Judge, Judgement, KindJudge } from "../judge/types.js";
import { estimateTokens } from "../recall/inject.js";
import { rosterModelId, rosterRoles, rosterSourceQuery } from "../roster/roster.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import { bankFor } from "../store/hindsight.js";
import type { RecallQuery, RetainItem } from "../store/types.js";
import { type HookDeps, HookEventError, handleHookEvent, parseHookEvent } from "./claude-code.js";

class SpyStore extends FakeStore {
	retainOptions: unknown[] = [];
	override retain(bank: string, items: RetainItem[], options?: { async?: boolean }) {
		this.retainOptions.push(options);
		return super.retain(bank, items);
	}
}

class RecallSpyStore extends FakeStore {
	topKs: number[] = [];
	override recall(bank: string, query: RecallQuery) {
		this.topKs.push(query.topK);
		return super.recall(bank, query);
	}
}

class UnreachableGetStore extends FakeStore {
	override async get(): Promise<never> {
		throw new Error("store down");
	}
}

/** A store whose models cannot be listed, for the roster's warning path. */
class DownRosterStore extends FakeStore {
	override async mentalModels(): Promise<never> {
		throw new Error("models down");
	}
}

let directory: string;
let state: LocalState;
let store: FakeStore;
let deps: HookDeps;
let cwd: string;
/** The roster fixture: one memory per of two roles and all four models, built once. */
let rosterStore: FakeStore;
/** A transcript whose Edit makes the cue's role developer: its own model is the one not shown. */
let developerTranscript: string;

const event = (fields: object) =>
	parseHookEvent(JSON.stringify({ session_id: "s", cwd, ...fields }));

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "dmn-handle-"));
	cwd = join(directory, "work");
	state = new LocalState({ directory: join(directory, "state") });
	store = new FakeStore();
	const config = loadConfig({
		env: { DMN_STORE_URL: "fake:" },
		configDir: join(directory, "config"),
	});
	deps = { store, state, config, random: () => 0.5, now: new Date("2026-01-01T00:00:00Z") };
	await store.retain("generic", [{ content: "retry with jitter", tags: [] }]);
	// The session-start roster rows share this fixture and the developer transcript.
	rosterStore = new FakeStore(() => new Date("2026-01-01T00:00:00Z"));
	await rosterStore.retain("generic", [
		{ content: "the developer keeps the build green", tags: ["role:developer"] },
		{
			content: "The reviewer cites the design doc. Flaky tests are tracked.",
			tags: ["role:reviewer"],
		},
	]);
	for (const role of rosterRoles) {
		await rosterStore.createMentalModel("generic", {
			id: rosterModelId(role),
			name: rosterModelId(role),
			sourceQuery: rosterSourceQuery(role),
			tags: [`role:${role}`],
			maxTokens: 512,
		});
	}
	developerTranscript = join(directory, "developer.jsonl");
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
});

afterAll(() => {
	state.close();
	rmSync(directory, { recursive: true, force: true });
});

test("parseHookEvent reads the fields of each event and rejects bad input", () => {
	expect(
		parseHookEvent(
			JSON.stringify({
				session_id: "s1",
				transcript_path: "/t.jsonl",
				cwd: "/c",
				hook_event_name: "PostToolUse",
				tool_name: "Read",
				tool_use_id: "toolu_1",
				tool_input: { file_path: "a" },
				tool_response: "ok",
			}),
		),
	).toEqual({
		name: "PostToolUse",
		sessionId: "s1",
		transcriptPath: "/t.jsonl",
		cwd: "/c",
		toolName: "Read",
		toolUseId: "toolu_1",
		toolInput: { file_path: "a" },
		toolResponse: "ok",
	});
	expect(
		parseHookEvent('{"hook_event_name":"Stop","cwd":"/c","stop_hook_active":true,"session_id":"s"}')
			.stopHookActive,
	).toBe(true);
	expect(() => parseHookEvent("nope")).toThrow(HookEventError);
	expect(() => parseHookEvent('{"hook_event_name":"Other","cwd":"/c"}')).toThrow(HookEventError);
	expect(() => parseHookEvent('{"hook_event_name":"Stop"}')).toThrow(HookEventError);
});

test("session start and prompt answer with additionalContext naming the event", async () => {
	for (const [name, fields] of [
		["SessionStart", { source: "startup" }],
		["UserPromptSubmit", { prompt: "jitter" }],
	] as const) {
		const output = await handleHookEvent(event({ hook_event_name: name, ...fields }), deps);
		expect(output?.hookSpecificOutput.hookEventName).toBe(name);
		expect(output?.hookSpecificOutput.additionalContext).toMatch(
			/^\[m:[^\]]+\] retry with jitter$/,
		);
	}
});

test("nothing recalled gives no output", async () => {
	const emptyDeps = { ...deps, store: new FakeStore() };
	expect(
		await handleHookEvent(event({ hook_event_name: "UserPromptSubmit", prompt: "x" }), emptyDeps),
	).toBeNull();
});

const postTool = (session_id: string) =>
	event({
		hook_event_name: "PostToolUse",
		session_id,
		tool_name: "Read",
		tool_input: { file_path: "retry.ts" },
	});
// A threshold far below the memory's activation makes the draw certain.
const eager = () => ({ ...deps, config: { ...deps.config, intrusionThreshold: -100 } });

test("a post-tool event gives one marked line", async () => {
	const output = await handleHookEvent(postTool("shape"), eager());
	expect(output?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
	expect(output?.hookSpecificOutput.additionalContext).toMatch(
		/^\[m:[^\]\n]+\] retry with jitter$/,
	);
});

test("a memory too long for the budget prints nothing and does not restart the cooldown", async () => {
	const tight = { ...eager(), config: { ...eager().config, budgetTokens: 1 } };
	expect(await handleHookEvent(postTool("budget"), tight)).toBeNull();
	expect(state.toolCallsSince("budget")).toBe(Number.POSITIVE_INFINITY);
});

test("a post-tool event recalls three candidates, and none when intrusions are off", async () => {
	const spy = new RecallSpyStore();
	await handleHookEvent(postTool("top-k"), { ...eager(), store: spy });
	expect(spy.topKs).toEqual([3]);
	const off = { ...deps, store: spy, config: { ...deps.config, intrusionThreshold: null } };
	spy.topKs = [];
	expect(await handleHookEvent(postTool("off"), off)).toBeNull();
	expect(spy.topKs).toEqual([]);
});

test("a store that cannot recall costs the thought, not the hook", async () => {
	class DownStore extends FakeStore {
		override async recall(): Promise<never> {
			throw new Error("store down");
		}
	}
	const warnings: string[] = [];
	const output = await handleHookEvent(postTool("down"), {
		...eager(),
		store: new DownStore(),
		onWarning: (message) => warnings.push(message),
	});
	expect(output).toBeNull();
	expect(warnings).toEqual(["dmn: intrusive recall failed: store down"]);
});

test("stop without a transcript, or with an empty one, does nothing", async () => {
	expect(await handleHookEvent(event({ hook_event_name: "Stop" }), deps)).toBeNull();
	const empty = join(directory, "empty.jsonl");
	writeFileSync(empty, "");
	expect(
		await handleHookEvent(event({ hook_event_name: "Stop", transcript_path: empty }), deps),
	).toBeNull();
	expect(await store.listTags("generic")).toEqual([]);
});

test("stop during a stop-hook continuation does nothing", async () => {
	const transcript = join(directory, "turn.jsonl");
	writeFileSync(
		transcript,
		[
			{ type: "user", uuid: "u", message: { role: "user", content: "How do retries work?" } },
			{ type: "assistant", uuid: "a", message: { role: "assistant", content: "With jitter." } },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	const stop = { hook_event_name: "Stop", transcript_path: transcript };
	await handleHookEvent(event({ ...stop, stop_hook_active: true }), deps);
	expect(await store.listTags("generic")).toEqual([]);
	const spy = new SpyStore();
	await handleHookEvent(event(stop), { ...deps, store: spy });
	expect((await spy.listTags("generic")).map(({ tag }) => tag)).toContain("kind:turn");
	// Fact extraction must not hold the hook up.
	expect(spy.retainOptions).toEqual([{ async: true }]);
});

const cite = (name: string, assistant: string): string => {
	const path = join(directory, name);
	writeFileSync(
		path,
		[
			{ type: "user", uuid: `u-${name}`, message: { role: "user", content: "What did we say?" } },
			{ type: "assistant", uuid: `a-${name}`, message: { role: "assistant", content: assistant } },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	return path;
};

test("a memory cited three times and another once count once each, however often stop runs", async () => {
	await store.retain("generic", [
		{ content: "alpha fact", tags: [] },
		{ content: "beta fact", tags: [] },
	]);
	const all = await store.list("generic", { limit: 50, offset: 0 });
	const idOf = (text: string) => all.find((memory) => memory.text === text)?.id as string;
	const [x, y] = [idOf("alpha fact"), idOf("beta fact")] as [string, string];
	const transcript_path = cite(
		"cited.jsonl",
		`[m:${x}] [m:${x}] [m:${x}] and [m:${y}], not [m:nope].`,
	);
	for (let run = 0; run < 2; run++) {
		await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), deps);
	}
	expect(state.uses(x).useCount).toBe(1);
	expect(state.uses(y).useCount).toBe(1);
	expect(state.uses("nope").useCount).toBe(0);
});

test("a store that cannot resolve cited ids costs the uses, not the retention", async () => {
	const down = new UnreachableGetStore();
	const warnings: string[] = [];
	const transcript_path = cite("down.jsonl", "As [m:abc] says.");
	await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), {
		...deps,
		store: down,
		onWarning: (message) => warnings.push(message),
	});
	expect(state.uses("abc").useCount).toBe(0);
	expect((await down.listTags("generic")).map(({ tag }) => tag)).toContain("kind:turn");
	expect(warnings.join("\n")).toContain("cannot resolve cited id abc: store down");
});

test("stop records one co-use edge per turn for the cited, known ids", async () => {
	await store.retain("generic", [
		{ content: "gamma fact", tags: [] },
		{ content: "delta fact", tags: [] },
	]);
	const all = await store.list("generic", { limit: 50, offset: 0 });
	const idOf = (text: string) => all.find((memory) => memory.text === text)?.id as string;
	const [g, d] = [idOf("gamma fact"), idOf("delta fact")] as [string, string];
	const calls: [string[], string][] = [];
	const spy = new Proxy(state, {
		get(target, property) {
			if (property === "recordCoUse") {
				return (ids: string[], turnId: string) => {
					calls.push([ids, turnId]);
					target.recordCoUse(ids, turnId);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const transcript_path = cite("co.jsonl", `[m:${g}] and [m:${d}], not [m:nope].`);
	await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), {
		...deps,
		state: spy,
	});
	expect(calls).toHaveLength(1);
	expect([...(calls[0]?.[0] ?? [])].sort()).toEqual([g, d].sort());
	expect(state.associations(g)).toEqual([{ id: d, weight: 1 }]);
});

test("stop records the cited use under the cue's project", async () => {
	await store.retain("generic", [{ content: "zeta fact", tags: [] }]);
	const all = await store.list("generic", { limit: 100, offset: 0 });
	const id = all.find((memory) => memory.text === "zeta fact")?.id as string;
	const transcript_path = cite("project.jsonl", `[m:${id}] says so.`);
	await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), deps);
	// Outside any space or repository the cue's project is `none`; that is what gets recorded.
	expect(state.projectsUsing(id)).toEqual(["none"]);
});

test("a judge gates the prompt injection and the intrusive thought by their own thresholds", async () => {
	const own = new FakeStore();
	await own.retain("generic", [{ content: "retry with jitter", tags: [] }]);
	const id = (await own.list("generic", { limit: 1, offset: 0 }))[0]?.id ?? "";
	const withJudge = (useful: number, extra: object = {}) => ({
		...deps,
		store: own,
		judge: new FakeJudge({ probabilities: { [id]: useful } }),
		...extra,
	});
	const prompt = event({ hook_event_name: "UserPromptSubmit", prompt: "retry with jitter" });
	const config = {
		...deps.config,
		judge: { ...deps.config.judge, threshold: 0.4, intrusionThreshold: 0.8 },
	};

	expect(await handleHookEvent(prompt, withJudge(0.39, { config }))).toBeNull();
	expect(
		(await handleHookEvent(prompt, withJudge(0.4, { config })))?.hookSpecificOutput
			.additionalContext,
	).toContain("retry with jitter");

	// 0.5 passes the prompt gate (0.4) but not the intrusive one (0.8).
	const eagerConfig = { ...config, intrusionThreshold: -100 };
	expect(
		await handleHookEvent(postTool("judged-low"), withJudge(0.5, { config: eagerConfig })),
	).toBeNull();
	expect(
		await handleHookEvent(postTool("judged-high"), withJudge(0.8, { config: eagerConfig })),
	).not.toBeNull();
});

test("a judge that fails costs the intrusive thought and warns", async () => {
	const warnings: string[] = [];
	const output = await handleHookEvent(postTool("judge-down"), {
		...eager(),
		judge: new FakeJudge({ failWith: new Error("judge down") }),
		onWarning: (message) => warnings.push(message),
	});
	expect(output).toBeNull();
	expect(warnings.join("\n")).toContain("judge down");
});

test("a judge that hangs is abandoned at the hook's store limit and costs only the tags", async () => {
	const transcript_path = cite("hang.jsonl", "Retries back off with jitter.");
	// classify never settles; the deadline race is the only way this Stop returns.
	const hanging: Judge & KindJudge = {
		judge: () => new Promise<Judgement[]>(() => {}),
		classify: () => new Promise<Classification[]>(() => {}),
	};
	const warnings: string[] = [];
	const judged = new FakeStore();
	await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), {
		...deps,
		// The store limit is the whole classify call's budget (a 5 ms real timer is the bound).
		config: { ...deps.config, storeTimeoutMs: 5 },
		store: judged,
		judge: hanging,
		onWarning: (message) => warnings.push(message),
	});
	expect(
		(await judged.list("generic", { limit: 10, offset: 0 })).map((item) => item.tags.at(-1)),
	).toEqual(["kind:turn", "kind:turn"]);
	expect(warnings).toEqual([expect.stringContaining("deadline")]);
});

test("stop tags the retained turns with the judge's kinds at the configured bar; a failing judge only warns", async () => {
	const transcript_path = cite("kinds.jsonl", "Retries back off with jitter, capped at five.");
	const userText = "What did we say?";

	const kinded = new FakeStore();
	await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), {
		...deps,
		store: kinded,
		judge: new FakeJudge({ kinds: { [userText]: { kind: "learning" } } }),
	});
	expect(
		(await kinded.list("generic", { limit: 10, offset: 0 })).map((item) => [
			item.text,
			item.tags.at(-1),
		]),
	).toEqual([
		[userText, "kind:learning"],
		["Retries back off with jitter, capped at five.", "kind:turn"],
	]);

	// 0.7 clears retainTurns' own default (0.5) but not the configured bar: only config's
	// kindThreshold can drop it here, and 0.9 clears it.
	const atConfiguredBar = async (probability: number) => {
		const judged = new FakeStore();
		await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), {
			...deps,
			config: { ...deps.config, judge: { ...deps.config.judge, kindThreshold: 0.8 } },
			store: judged,
			judge: new FakeJudge({
				kinds: { [userText]: { kind: "learning", probability } },
			}),
		});
		return (await judged.list("generic", { limit: 10, offset: 0 })).map((item) => item.tags.at(-1));
	};
	expect(await atConfiguredBar(0.7)).toEqual(["kind:turn", "kind:turn"]);
	expect(await atConfiguredBar(0.9)).toEqual(["kind:learning", "kind:turn"]);

	const warnings: string[] = [];
	const failing = new FakeStore();
	await handleHookEvent(event({ hook_event_name: "Stop", transcript_path }), {
		...deps,
		store: failing,
		judge: new FakeJudge({ failWith: new Error("judge down") }),
		onWarning: (message) => warnings.push(message),
	});
	expect(
		(await failing.list("generic", { limit: 10, offset: 0 })).map((item) => item.tags.at(-1)),
	).toEqual(["kind:turn", "kind:turn"]);
	expect(warnings).toEqual([expect.stringContaining("judge down")]);
});

test("session start appends one roster line per other role after the memory lines; a prompt event none", async () => {
	const start = await handleHookEvent(
		event({
			hook_event_name: "SessionStart",
			source: "startup",
			transcript_path: developerTranscript,
		}),
		{ ...deps, store: rosterStore },
	);
	const context = start?.hookSpecificOutput.additionalContext ?? "";
	const lines = context.split("\n");
	// The memory lines keep their shape; the roster lines come after them.
	expect(lines[0]).toMatch(/^\[m:/);
	expect(lines.filter((line) => line.startsWith("[roster:"))).toEqual([
		"[roster:reviewer] The reviewer cites the design doc.",
	]);
	expect(lines.at(-1)).toBe("[roster:reviewer] The reviewer cites the design doc.");
	// The whole block, roster lines included, stays inside the budget.
	expect(estimateTokens(context)).toBeLessThanOrEqual(deps.config.budgetTokens);

	const prompt = await handleHookEvent(
		event({
			hook_event_name: "UserPromptSubmit",
			prompt: "build",
			transcript_path: developerTranscript,
		}),
		{ ...deps, store: rosterStore },
	);
	expect(prompt?.hookSpecificOutput.additionalContext ?? "").not.toContain("[roster:");
});

test("an empty model in the organization bank does not shadow the generic bank's model", async () => {
	// The organization bank holds all four models with nothing behind them; generic holds the
	// reviewer's memory, so only its model can say anything.
	const twoBanks = new FakeStore(() => new Date("2026-01-01T00:00:00Z"));
	await twoBanks.retain(bankFor(undefined), [
		{ content: "The reviewer writes the summary.", tags: ["role:reviewer"] },
	]);
	for (const visited of [bankFor("acme"), bankFor(undefined)]) {
		for (const role of rosterRoles) {
			await twoBanks.createMentalModel(visited, {
				id: rosterModelId(role),
				name: rosterModelId(role),
				sourceQuery: rosterSourceQuery(role),
				tags: [`role:${role}`],
				maxTokens: 512,
			});
		}
	}
	// A space under a mapped directory gives the cue an organization, so the hook reads two banks.
	const rosterSpace = join(directory, "acmeorg", "space");
	mkdirSync(rosterSpace, { recursive: true });
	writeFileSync(join(rosterSpace, "HYPER.md"), "");
	const output = await handleHookEvent(
		event({
			hook_event_name: "SessionStart",
			source: "startup",
			cwd: rosterSpace,
			transcript_path: developerTranscript,
		}),
		{ ...deps, store: twoBanks, config: { ...deps.config, organizations: { acmeorg: "acme" } } },
	);
	const lines = (output?.hookSpecificOutput.additionalContext ?? "").split("\n");
	expect(lines.filter((line) => line.startsWith("[roster:"))).toEqual([
		"[roster:reviewer] The reviewer writes the summary.",
	]);
});

test("a roster line that cannot fit the budget left by the memory lines is dropped", async () => {
	// Budget 20: the developer memory's line spends 19 tokens of it, and the newline joining a
	// roster line would spend the last one — the 13-token roster line cannot fit.
	const tight = { ...deps, store: rosterStore, config: { ...deps.config, budgetTokens: 20 } };
	const output = await handleHookEvent(
		event({
			hook_event_name: "SessionStart",
			source: "startup",
			transcript_path: developerTranscript,
		}),
		tight,
	);
	const context = output?.hookSpecificOutput.additionalContext ?? "";
	expect(context).toMatch(/^\[m:[^\]]+\] the developer keeps the build green$/);
	expect(context).not.toContain("[roster:");
	expect(estimateTokens(context)).toBeLessThanOrEqual(20);
});

test("a store that cannot list models costs the roster lines, not the injection", async () => {
	const roster = new DownRosterStore();
	await roster.retain("generic", [{ content: "the developer keeps the build green", tags: [] }]);
	const warnings: string[] = [];
	const output = await handleHookEvent(
		event({ hook_event_name: "SessionStart", source: "startup" }),
		{
			...deps,
			store: roster,
			onWarning: (message) => warnings.push(message),
		},
	);
	expect(output?.hookSpecificOutput.additionalContext).toMatch(/^\[m:/);
	expect(warnings).toEqual([expect.stringContaining("models down")]);
});
