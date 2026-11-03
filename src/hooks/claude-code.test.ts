import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import type { MemoryStore } from "../store/types.js";
import { type HookDeps, HookEventError, handleHookEvent, parseHookEvent } from "./claude-code.js";

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

test("nothing recalled and a post-tool event give no output", async () => {
	const emptyDeps = { ...deps, store: new FakeStore() };
	expect(
		await handleHookEvent(event({ hook_event_name: "UserPromptSubmit", prompt: "x" }), emptyDeps),
	).toBeNull();
	expect(
		await handleHookEvent(event({ hook_event_name: "PostToolUse", tool_name: "Read" }), deps),
	).toBeNull();
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
	const retained: unknown[] = [];
	const spy: MemoryStore = {
		...store,
		get: (bank, id) => store.get(bank, id),
		retain: (bank, items, options) => {
			retained.push(options);
			return store.retain(bank, items);
		},
	} as MemoryStore;
	await handleHookEvent(event(stop), { ...deps, store: spy });
	expect((await store.listTags("generic")).map(({ tag }) => tag)).toContain("kind:turn");
	// Fact extraction must not hold the hook up.
	expect(retained).toEqual([{ async: true }]);
});
