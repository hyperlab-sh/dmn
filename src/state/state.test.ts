import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "./state.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

let directory: string;
let state: LocalState;
let now: Date;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "dmn-state-"));
	state = new LocalState({ directory: join(directory, "nested"), clock: () => now });
});

afterAll(() => {
	state.close();
	rmSync(directory, { recursive: true, force: true });
});

test("creates state.sqlite under the given directory", () => {
	expect(existsSync(join(directory, "nested", "state.sqlite"))).toBe(true);
});

test("uses of an unknown id are zero", () => {
	expect(state.uses("unknown")).toEqual({ useCount: 0, firstSeenAt: null, lastUsedAt: null });
});

test("recordUse counts once per turn and tracks first and last use", () => {
	now = at(0);
	state.recordUse("m1", "turn-1");
	now = at(2);
	state.recordUse("m1", "turn-1");
	expect(state.uses("m1").useCount).toBe(1);
	now = at(5);
	state.recordUse("m1", "turn-2");
	expect(state.uses("m1")).toEqual({
		useCount: 2,
		firstSeenAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: "2026-01-01T00:00:05.000Z",
	});
	state.recordUse("m2", "turn-1");
	expect(state.uses("m2").useCount).toBe(1);
});

test("dormancy round trip: set, check, revive", () => {
	now = at(0);
	expect(state.isDormant("m3")).toBe(false);
	state.setDormant("m3");
	state.setDormant("m3");
	expect(state.isDormant("m3")).toBe(true);
	state.revive("m3");
	expect(state.isDormant("m3")).toBe(false);
});

test("tagFanCache returns fresh counts and null once stale", () => {
	now = at(0);
	expect(state.tagFanCache.read("b", 60_000)).toBeNull();
	state.tagFanCache.write("b", [{ tag: "t", count: 3 }]);
	now = at(30);
	expect(state.tagFanCache.read("b", 60_000)).toEqual([{ tag: "t", count: 3 }]);
	now = at(90);
	expect(state.tagFanCache.read("b", 60_000)).toBeNull();
});

test("intrusions count tool calls since the last emission, and a session without one is never in cooldown", () => {
	expect(state.toolCallsSince("s1")).toBe(Number.POSITIVE_INFINITY);
	state.bumpToolCalls("s1");
	expect(state.toolCallsSince("s1")).toBe(Number.POSITIVE_INFINITY);
	state.markIntrusion("s1");
	expect(state.toolCallsSince("s1")).toBe(0);
	state.bumpToolCalls("s1");
	state.bumpToolCalls("s1");
	expect(state.toolCallsSince("s1")).toBe(2);
	expect(state.toolCallsSince("s2")).toBe(Number.POSITIVE_INFINITY);
	state.markIntrusion("s1");
	expect(state.toolCallsSince("s1")).toBe(0);
});

test("recordCoUse writes each pair once per turn, adds weight across turns and stamps last_at", () => {
	now = at(0);
	state.recordCoUse(["b", "a", "c"], "co-1");
	state.recordCoUse(["b", "a", "c"], "co-1");
	expect(state.associations("a")).toEqual([
		{ id: "b", weight: 1 },
		{ id: "c", weight: 1 },
	]);
	expect(state.associations("c")).toEqual([
		{ id: "a", weight: 1 },
		{ id: "b", weight: 1 },
	]);
	expect(state.associationFan("a")).toBe(2);
	now = at(9);
	state.recordCoUse(["a", "b"], "co-2");
	expect(state.associations("a")).toEqual([
		{ id: "b", weight: 2 },
		{ id: "c", weight: 1 },
	]);
	const reader = new Database(join(directory, "nested", "state.sqlite"), { readonly: true });
	try {
		const lastAt = (a: string, b: string) =>
			reader
				.query<{ last_at: string }, [string, string]>(
					"SELECT last_at FROM co_use WHERE a = ? AND b = ?",
				)
				.get(a, b)?.last_at;
		expect(lastAt("a", "b")).toBe("2026-01-01T00:00:09.000Z");
		expect(lastAt("a", "c")).toBe("2026-01-01T00:00:00.000Z");
	} finally {
		reader.close();
	}
});

test("recordCoUse with fewer than two distinct ids writes nothing", () => {
	state.recordCoUse([], "co-3");
	state.recordCoUse(["solo"], "co-3");
	state.recordCoUse(["solo", "solo"], "co-3");
	expect(state.associations("solo")).toEqual([]);
	expect(state.associationFan("solo")).toBe(0);
});

test("opening a state file whose co_use predates last_at adds the column", () => {
	const old = mkdtempSync(join(tmpdir(), "dmn-state-old-"));
	try {
		const legacy = new Database(join(old, "state.sqlite"), { create: true });
		legacy.exec(
			"CREATE TABLE co_use (a TEXT NOT NULL, b TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY (a, b))",
		);
		legacy.close();
		const upgraded = new LocalState({ directory: old, clock: () => at(7) });
		try {
			upgraded.recordCoUse(["a", "b"], "t");
			expect(upgraded.associations("a")).toEqual([{ id: "b", weight: 1 }]);
		} finally {
			upgraded.close();
		}
		const reader = new Database(join(old, "state.sqlite"), { readonly: true });
		try {
			expect(
				reader.query<{ last_at: string }, []>("SELECT last_at FROM co_use").get()?.last_at,
			).toBe("2026-01-01T00:00:07.000Z");
		} finally {
			reader.close();
		}
	} finally {
		rmSync(old, { recursive: true, force: true });
	}
});

test("pair keys of ids containing ':' do not collide", () => {
	now = at(0);
	state.recordCoUse(["x", "y:z"], "colon-1");
	state.recordCoUse(["x:y", "z"], "colon-1");
	expect(state.associations("x")).toEqual([{ id: "y:z", weight: 1 }]);
	expect(state.associations("x:y")).toEqual([{ id: "z", weight: 1 }]);
});
