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
