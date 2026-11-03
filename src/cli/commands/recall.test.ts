import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../../state/state.js";
import { startFakeServer } from "../../store/fake.js";
import { bankFor, HindsightStore } from "../../store/hindsight.js";
import { runRecall } from "./recall.js";

const root = new URL("../../..", import.meta.url).pathname;
const now = new Date("2026-06-01T00:00:00Z");
const reviewerTexts = [
	"The reviewer cites the design doc.",
	"The reviewer tracks flaky tests.",
	"The reviewer reads the runbook.",
];

let server: ReturnType<typeof startFakeServer>;
let scratch: string;
let space: string;
let env: Record<string, string>;
let reviewerIds: string[];

/** Async spawn: the fake server lives in this process and must keep answering. */
async function dmn(...args: string[]) {
	// Run inside the space: recall builds its cue from the working directory.
	const child = Bun.spawn(["bun", join(root, "src/cli/index.ts"), "recall", ...args], {
		cwd: space,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

beforeAll(async () => {
	server = startFakeServer();
	scratch = mkdtempSync(join(tmpdir(), "dmn-recall-cli-"));
	space = join(scratch, "workspace", "acmeorg", "space");
	mkdirSync(space, { recursive: true });
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
	};
	const store = new HindsightStore({ baseUrl: server.url });
	await store.retain(bankFor("acme"), [
		...reviewerTexts.map((text) => ({ content: text, tags: ["role:reviewer"] })),
		{ content: "The developer keeps the build green.", tags: ["role:developer"] },
	]);
	const all = await store.list(bankFor("acme"), { limit: 10, offset: 0 });
	reviewerIds = reviewerTexts.map(
		(text) => all.find((memory) => memory.text === text)?.id as string,
	);
	// The middle reviewer memory is dormant: recall must drop it while keeping the store order.
	const state = new LocalState({ directory: join(scratch, "state", "dmn"), clock: () => now });
	state.setDormant(reviewerIds[1] as string);
	state.close();
});

afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("recall lists one marked line per reviewer memory in store order, dormant ids dropped", async () => {
	const result = await dmn("--role", "reviewer");
	expect(result).toMatchObject({ exitCode: 0, stderr: "" });
	expect(result.stdout.split("\n").filter(Boolean)).toEqual([
		`[m:${reviewerIds[0]}] ${reviewerTexts[0]}`,
		`[m:${reviewerIds[2]}] ${reviewerTexts[2]}`,
	]);
	// None of the developer role's memories, none of its own noise.
	expect(result.stdout).not.toContain("developer");
});

test("--top 1 prints one line", async () => {
	const result = await dmn("--role", "reviewer", "--top", "1");
	expect(result).toMatchObject({ exitCode: 0, stderr: "" });
	expect(result.stdout.split("\n").filter(Boolean)).toEqual([
		`[m:${reviewerIds[0]}] ${reviewerTexts[0]}`,
	]);
});

test("an unknown role refuses with exit 1 naming the roles", async () => {
	const written: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		expect(await runRecall(["--role", "bogus"], env)).toBe(1);
	} finally {
		process.stderr.write = original;
	}
	expect(written.join("")).toContain("architect, developer, reviewer, operator");
});
