import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../config/config.js";
import { startFakeServer } from "../../store/fake.js";
import { bankFor, HindsightStore } from "../../store/hindsight.js";
import { hookJudge, runHook } from "./hook.js";

const root = new URL("../../..", import.meta.url).pathname;
const fixtures = join(root, "fixtures/hooks");

let store: ReturnType<typeof startFakeServer>;
let judgeStub: ReturnType<typeof Bun.serve>;
let requests: { authorization: string | null; states: string[] }[];
let scratch: string;
let space: string;

/** Runs `dmn hook user-prompt` with a config whose judge section is `judge`. */
async function userPrompt(name: string, judge: object) {
	const configHome = join(scratch, name);
	mkdirSync(join(configHome, "dmn"), { recursive: true });
	writeFileSync(
		join(configHome, "dmn", "config.json"),
		JSON.stringify({ organizations: { acmeorg: "acme" }, judge }),
	);
	const input = readFileSync(join(fixtures, "user-prompt.json"), "utf8")
		.replace("__CWD__", space)
		.replace("__TRANSCRIPT__", join(fixtures, "transcript.jsonl"));
	const child = Bun.spawn(["bun", "src/cli/index.ts", "hook", "user-prompt"], {
		cwd: root,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: scratch,
			DMN_STORE_URL: store.url,
			LAYA_API_KEY: "stub-key",
			XDG_STATE_HOME: join(scratch, "state"),
			XDG_CONFIG_HOME: configHome,
			DMN_SEED: "11",
			DMN_NOW: "2100-01-01T00:00:00Z",
		},
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const lines = stdout
		? (JSON.parse(stdout).hookSpecificOutput.additionalContext as string).split("\n")
		: [];
	return { lines, stderr, exitCode };
}

beforeAll(async () => {
	store = startFakeServer();
	scratch = mkdtempSync(join(tmpdir(), "dmn-hook-judge-"));
	space = join(scratch, "workspace", "acmeorg", "space");
	mkdirSync(space, { recursive: true });
	writeFileSync(join(space, "HYPER.md"), "");
	await new HindsightStore({ baseUrl: store.url }).retain(bankFor("acme"), [
		{ content: "Retry delays in the sync worker use jitter.", tags: ["project:space"] },
		{ content: "Sync worker retries are capped at five attempts.", tags: ["project:space"] },
	]);
	requests = [];
	// Answers the Laya batch API: P(useful) is high only for the memory that mentions jitter.
	judgeStub = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { requests: { state: string }[] };
			requests.push({
				authorization: request.headers.get("authorization"),
				states: body.requests.map((item) => item.state),
			});
			return Response.json({
				results: body.requests.map((item) => ({
					answers: {
						useful: { type: "noul", noul: item.state.includes("jitter.") ? 0.9 : 0.1 },
						level: { type: "score", score: 1 },
					},
				})),
			});
		},
	});
});

afterAll(() => {
	store.stop();
	judgeStub.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

test("provider laya injects only what the judge marks useful; none sends no request; an unreachable judge warns and injects unfiltered", async () => {
	const stubUrl = `http://localhost:${judgeStub.port}`;

	const gated = await userPrompt("laya", { provider: "laya", baseUrl: stubUrl });
	expect(gated.exitCode).toBe(0);
	expect(gated.stderr).toBe("");
	expect(gated.lines).toHaveLength(1);
	expect(gated.lines[0]).toContain("Retry delays in the sync worker use jitter.");
	expect(requests).toHaveLength(1);
	expect(requests[0]?.authorization).toBe("Bearer stub-key");

	requests = [];
	const off = await userPrompt("none", { provider: "none", baseUrl: stubUrl });
	expect(off.exitCode).toBe(0);
	expect(off.lines).toHaveLength(2);
	expect(requests).toHaveLength(0);

	const unreachable = await userPrompt("down", { provider: "laya", baseUrl: "http://localhost:1" });
	expect(unreachable.exitCode).toBe(0);
	expect(unreachable.lines).toHaveLength(2);
	expect(unreachable.stderr).toContain("dmn: judge: ");
	expect(unreachable.stderr).not.toContain("stub-key");
});

test("provider laya without LAYA_API_KEY is a config error: exit 2 for user-prompt, 1 for post-tool", async () => {
	const configHome = join(scratch, "nokey");
	mkdirSync(join(configHome, "dmn"), { recursive: true });
	writeFileSync(
		join(configHome, "dmn", "config.json"),
		JSON.stringify({ judge: { provider: "laya" } }),
	);
	const env = { HOME: scratch, DMN_STORE_URL: store.url, XDG_CONFIG_HOME: configHome };
	expect(await runHook("user-prompt", env)).toBe(2);
	expect(await runHook("post-tool", env)).toBe(1);
});

test("hookJudge builds no judge for Stop, or for post-tool with intrusions off, and throws without a key", () => {
	const config = loadConfig({
		env: { DMN_STORE_URL: "fake:", HOME: scratch },
		configDir: join(scratch, "nokey", "dmn"),
	});
	expect(config.judge.provider).toBe("laya");
	expect(hookJudge("Stop", config, {})).toBeUndefined();
	expect(hookJudge("PostToolUse", { ...config, intrusionThreshold: null }, {})).toBeUndefined();
	expect(() => hookJudge("UserPromptSubmit", config, {})).toThrow(ConfigError);
	expect(() => hookJudge("PostToolUse", config, {})).toThrow(ConfigError);
	expect(hookJudge("UserPromptSubmit", config, { LAYA_API_KEY: "k" })).toBeDefined();
});
