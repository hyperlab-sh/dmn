import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultActivationParameters } from "../activation/act-r.js";
import { ConfigError, loadConfig } from "./config.js";

let root: string;
let emptyDir: string;
let partialDir: string;
let brokenDir: string;
let badActivationDir: string;
let unknownActivationDir: string;
const env = { DMN_STORE_URL: "http://store.test", HOME: "/home/test" };

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "dmn-config-"));
	emptyDir = join(root, "empty");
	partialDir = join(root, "partial");
	brokenDir = join(root, "broken");
	badActivationDir = join(root, "bad-activation");
	unknownActivationDir = join(root, "unknown-activation");
	for (const dir of [emptyDir, partialDir, brokenDir, badActivationDir, unknownActivationDir]) {
		mkdirSync(dir);
	}
	writeFileSync(
		join(badActivationDir, "config.json"),
		JSON.stringify({ activation: { decay: "0.5" } }),
	);
	writeFileSync(
		join(unknownActivationDir, "config.json"),
		JSON.stringify({ activation: { decya: 0.5 } }),
	);
	writeFileSync(
		join(partialDir, "config.json"),
		JSON.stringify({ topK: 3, organizations: { box: "acme" }, activation: { decay: 0.4 } }),
	);
	writeFileSync(join(brokenDir, "config.json"), JSON.stringify({ topK: "many" }));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("returns the documented defaults when config.json is absent", () => {
	expect(loadConfig({ env, configDir: emptyDir })).toEqual({
		storeUrl: "http://store.test",
		budgetTokens: 600,
		topK: 10,
		promptThreshold: -0.5,
		intrusionThreshold: 0.5,
		intrusionCooldown: 5,
		dormancyFloor: -2.0,
		protectedTags: ["decision", "correction", "identity", "person"],
		organizations: {},
		replayDir: "/home/test/.local/share/dmn/replay",
		stateDir: "/home/test/.local/state/dmn",
		storeTimeoutMs: 2000,
		retainTimeoutMs: 60_000,
		fanCacheSeconds: 300,
		activation: { ...defaultActivationParameters },
	});
});

test("merges a partial config.json over the defaults", () => {
	const config = loadConfig({ env, configDir: partialDir });
	expect(config.topK).toBe(3);
	expect(config.budgetTokens).toBe(600);
	expect(config.organizations).toEqual({ box: "acme" });
	expect(config.activation).toEqual({ ...defaultActivationParameters, decay: 0.4 });
});

test("honours XDG_STATE_HOME and XDG_DATA_HOME", () => {
	const config = loadConfig({
		env: { ...env, XDG_STATE_HOME: "/x/state", XDG_DATA_HOME: "/x/data" },
		configDir: emptyDir,
	});
	expect(config.stateDir).toBe("/x/state/dmn");
	expect(config.replayDir).toBe("/x/data/dmn/replay");
});

test("throws ConfigError naming DMN_STORE_URL when it is unset", () => {
	expect(() => loadConfig({ env: {}, configDir: emptyDir })).toThrow(ConfigError);
	expect(() => loadConfig({ env: {}, configDir: emptyDir })).toThrow(/DMN_STORE_URL/);
});

test("throws ConfigError for a malformed DMN_STORE_URL and accepts fake:", () => {
	const malformed = { ...env, DMN_STORE_URL: "127.0.0.1:8888" };
	expect(() => loadConfig({ env: malformed, configDir: emptyDir })).toThrow(ConfigError);
	expect(() => loadConfig({ env: malformed, configDir: emptyDir })).toThrow(/DMN_STORE_URL/);
	expect(
		loadConfig({ env: { ...env, DMN_STORE_URL: "fake:" }, configDir: emptyDir }).storeUrl,
	).toBe("fake:");
});

test("throws ConfigError for a mistyped value, a mistyped or an unknown activation key", () => {
	expect(() => loadConfig({ env, configDir: brokenDir })).toThrow(/topK/);
	expect(() => loadConfig({ env, configDir: badActivationDir })).toThrow(/activation\.decay/);
	expect(() => loadConfig({ env, configDir: unknownActivationDir })).toThrow(/activation\.decya/);
});
