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
const liveTexts = ["The reviewer cites the design doc.", "The reviewer reads the runbook."];
// Shares both words of the "reviewer role" query, so the store ranks the dormant memory first.
const dormantText = "The reviewer role owns the flaky test list.";
const genericText = "The reviewer writes the summary.";

let server: ReturnType<typeof startFakeServer>;
let scratch: string;
let space: string;
let env: Record<string, string>;
let liveIds: string[];
let dormantId: string;
let genericId: string;

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
	// Insertion order: the live ones first, the dormant one between them in store order.
	await store.retain(bankFor("acme"), [
		...liveTexts.flatMap((text, index) =>
			index === 0
				? [
						{ content: text, tags: ["role:reviewer"] },
						{ content: dormantText, tags: ["role:reviewer"] },
					]
				: [{ content: text, tags: ["role:reviewer"] }],
		),
		{ content: "The developer keeps the build green.", tags: ["role:developer"] },
	]);
	// A reviewer memory in the other bank, so --top must hold across both banks.
	await store.retain(bankFor(undefined), [{ content: genericText, tags: ["role:reviewer"] }]);
	const organization = await store.list(bankFor("acme"), { limit: 10, offset: 0 });
	const generic = await store.list(bankFor(undefined), { limit: 10, offset: 0 });
	const idOf = (records: typeof organization, text: string) =>
		records.find((memory) => memory.text === text)?.id as string;
	liveIds = liveTexts.map((text) => idOf(organization, text));
	dormantId = idOf(organization, dormantText);
	genericId = idOf(generic, genericText);
	const state = new LocalState({ directory: join(scratch, "state", "dmn"), clock: () => now });
	state.setDormant(dormantId);
	state.close();
});

afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("recall lists one marked line per reviewer memory in store order, dormant ids dropped", async () => {
	const result = await dmn("--role", "reviewer");
	expect(result).toMatchObject({ exitCode: 0, stderr: "" });
	// The organization bank first, then generic; the dormant memory never appears.
	expect(result.stdout.split("\n").filter(Boolean)).toEqual([
		`[m:${liveIds[0]}] ${liveTexts[0]}`,
		`[m:${liveIds[1]}] ${liveTexts[1]}`,
		`[m:${genericId}] ${genericText}`,
	]);
	// None of the developer role's memories, none of its own noise.
	expect(result.stdout).not.toContain("developer");
});

test("--top 1 prints one line, across both banks and past the dormant memory", async () => {
	const result = await dmn("--role", "reviewer", "--top", "1");
	expect(result).toMatchObject({ exitCode: 0, stderr: "" });
	// The store ranks the dormant memory first: the one line is the best live one, from the
	// organization bank — not the generic bank's, which a per-bank top would have printed.
	expect(result.stdout.split("\n").filter(Boolean)).toEqual([`[m:${liveIds[0]}] ${liveTexts[0]}`]);
});

test("an unknown role refuses with exit 1 naming the roles", async () => {
	const stderr: string[] = [];
	const written: string[] = [];
	expect(
		await runRecall(["--role", "bogus"], env, {
			stdout: (text) => written.push(text),
			stderr: (text) => stderr.push(text),
		}),
	).toBe(1);
	expect(stderr.join("")).toContain("architect, developer, reviewer, operator");
	expect(written).toEqual([]);
});
