import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import { fanCounts } from "./fan.js";

let directory: string;
let state: LocalState;
let clock: Date;
let listTagsCalls: string[];
const store = new FakeStore();
const counted = {
	listTags: (bank: string) => {
		listTagsCalls.push(bank);
		return store.listTags(bank);
	},
};

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "dmn-fan-"));
	clock = new Date("2026-06-01T00:00:00Z");
	state = new LocalState({ directory, clock: () => clock });
	await store.retain("org-acme", [
		{ content: "one", tags: ["stack:bun", "project:web"] },
		{ content: "two", tags: ["stack:bun"] },
	]);
	await store.retain("generic", [{ content: "three", tags: ["stack:bun", "kind:turn"] }]);
});

afterAll(() => {
	state.close();
	rmSync(directory, { recursive: true, force: true });
});

test("sums per-tag counts across banks; the TTL spares the store, expiry hits it again", async () => {
	listTagsCalls = [];
	const banks = ["org-acme", "generic"];
	const first = await fanCounts(counted, state, banks, 300);
	expect(first.get("stack:bun")).toBe(3);
	expect(first.get("project:web")).toBe(1);
	expect(first.get("kind:turn")).toBe(1);
	expect(listTagsCalls.sort()).toEqual(["generic", "org-acme"]);

	clock = new Date(clock.getTime() + 299_000);
	expect(await fanCounts(counted, state, banks, 300)).toEqual(first);
	expect(listTagsCalls).toHaveLength(2);

	clock = new Date(clock.getTime() + 2_000);
	await fanCounts(counted, state, banks, 300);
	expect(listTagsCalls).toHaveLength(4);
});

test("a failing listTags contributes nothing instead of rejecting", async () => {
	const failing = { listTags: () => Promise.reject(new Error("down")) };
	const reported: string[] = [];
	const counts = await fanCounts(failing, state, ["unseen-bank"], 300, (bank) =>
		reported.push(bank),
	);
	expect(counts).toEqual(new Map());
	expect(reported).toEqual(["unseen-bank"]);
});
