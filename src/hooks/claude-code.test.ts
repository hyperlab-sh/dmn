import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
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

let directory: string;
let state: LocalState;
let store: FakeStore;
let deps: HookDeps;
let cwd: string;

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

test("a post-tool event gives one marked line when the draw is won, then nothing in the cooldown", async () => {
	const postTool = (session_id: string, extra: object = {}) =>
		event({
			hook_event_name: "PostToolUse",
			session_id,
			tool_name: "Read",
			tool_input: { file_path: "retry.ts" },
			...extra,
		});
	// A threshold far below the memory's activation makes the draw certain.
	const eager = { ...deps, config: { ...deps.config, intrusionThreshold: -100 } };
	const first = await handleHookEvent(postTool("intrusive"), eager);
	expect(first?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
	expect(first?.hookSpecificOutput.additionalContext).toMatch(/^\[m:[^\]\n]+\] retry with jitter$/);
	expect(await handleHookEvent(postTool("intrusive"), eager)).toBeNull();
	// Another session has its own cooldown; a threshold above reach, or null, never surfaces.
	const never = { ...deps, config: { ...deps.config, intrusionThreshold: 100 } };
	expect(await handleHookEvent(postTool("quiet"), never)).toBeNull();
	const off = { ...deps, config: { ...deps.config, intrusionThreshold: null } };
	expect(await handleHookEvent(postTool("off"), off)).toBeNull();
	expect(state.toolCallsSince("off")).toBe(Number.POSITIVE_INFINITY);
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

test("a post-tool event recalls three candidates, not the prompt-time ten", async () => {
	const spy = new RecallSpyStore();
	await handleHookEvent(
		event({ hook_event_name: "PostToolUse", session_id: "top-k", tool_name: "Read" }),
		{ ...deps, store: spy },
	);
	expect(spy.topKs).toEqual([3]);
});
