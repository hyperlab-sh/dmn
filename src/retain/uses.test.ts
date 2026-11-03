import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../state/state.js";
import { extractUses, recordUses } from "./uses.js";

let directory: string;
let state: LocalState;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "dmn-uses-"));
	state = new LocalState({ directory });
});

afterAll(() => {
	state.close();
	rmSync(directory, { recursive: true, force: true });
});

test("extractUses returns each cited id once, ignoring look-alikes", () => {
	const text = "See [m:a1], [m:a1] and [m:a1]; also [m:b2]. Not [m:] or [mem:c3] or m:d4.";
	expect(extractUses(text)).toEqual(new Set(["a1", "b2"]));
});

test("a turn counts each cited memory once and a repeat of the turn counts nothing", () => {
	const cited = extractUses("[m:a1] [m:a1] [m:a1] [m:b2]");
	recordUses(state, cited, "turn-1");
	recordUses(state, cited, "turn-1");
	expect(state.uses("a1").useCount).toBe(1);
	expect(state.uses("b2").useCount).toBe(1);

	recordUses(state, ["a1"], "turn-2");
	expect(state.uses("a1").useCount).toBe(2);
	expect(state.uses("b2").useCount).toBe(1);
});
