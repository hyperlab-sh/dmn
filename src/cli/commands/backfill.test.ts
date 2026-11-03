import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeServer } from "../../store/fake.js";
import { HindsightStore } from "../../store/hindsight.js";
import { runBackfill } from "./backfill.js";

const root = new URL("../../..", import.meta.url).pathname;
const fixture = join(root, "fixtures/replay/live-a.jsonl");

let scratch: string;
let server: ReturnType<typeof startFakeServer>;
let store: HindsightStore;

/** Calls the command in-process with a captured stdout/stderr; backfill takes env as an arg. */
async function backfill(
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string; err: string }> {
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	let out = "";
	let err = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err += chunk;
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runBackfill(args, env);
		return { code, out, err };
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-backfill-test-"));
	server = startFakeServer();
	store = new HindsightStore({ baseUrl: server.url });
});
afterAll(() => {
	server.stop();
	rmSync(scratch, { recursive: true, force: true });
});

/** One timed prompt and its assistant answer, as a transcript line pair. */
function exchange(at: string, text: string): string {
	return `${[
		JSON.stringify({
			type: "user",
			cwd: "/home/dev/acme/widgets",
			timestamp: at,
			message: { role: "user", content: text },
		}),
		JSON.stringify({
			type: "assistant",
			cwd: "/home/dev/acme/widgets",
			timestamp: `${at.slice(0, -8)}30.000Z`,
			message: { role: "assistant", content: [{ type: "text", text: `Answer to ${text}` }] },
		}),
	].join("\n")}\n`;
}

test("--dry writes nothing and prints per-transcript prompts, retained and skipped reasons", async () => {
	// A prompt whose answer holds a secret: the filter must say so without reaching the store.
	const secret = join(scratch, "secret.jsonl");
	writeFileSync(
		secret,
		`${[
			JSON.stringify({
				type: "user",
				cwd: "/home/dev/acme/widgets",
				timestamp: "2026-01-05T09:00:00.000Z",
				message: { role: "user", content: "Ship the release with the deploy token" },
			}),
			JSON.stringify({
				type: "assistant",
				cwd: "/home/dev/acme/widgets",
				timestamp: "2026-01-05T09:00:30.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Deployed with ghp_A0aB1cC2dD3eE4fF5gG6hH7iI8jJ9kK" }],
				},
			}),
		].join("\n")}\n`,
	);
	const dry = await backfill(["--dry", fixture, secret], {
		DMN_STORE_URL: server.url,
		HOME: "/home/test",
	});
	expect(dry.code).toBe(0);
	// One line per transcript: the fixture retains everything, the secret answer is skipped.
	expect(dry.out.split("\n").filter(Boolean)).toEqual([
		`${fixture}: prompts=3 retained=6 skipped=0`,
		`${secret}: prompts=1 retained=1 skipped=1 secret=1`,
	]);
	// The configured store's bank stays empty: --dry wrote nothing to the store it was pointed at.
	expect(await store.list("generic", { limit: 50, offset: 0 })).toEqual([]);
});

test("backfill retains both turns with the prompt's time, at most --max-turns per transcript", async () => {
	const run = await backfill([fixture, "--max-turns", "2"], {
		DMN_STORE_URL: server.url,
		HOME: "/home/test",
	});
	expect(run.err).toBe("");
	expect(run.code).toBe(0);
	expect(run.out.split("\n").filter(Boolean)).toEqual([
		`${fixture}: prompts=2 retained=4 skipped=0`,
		"total retained 4",
	]);
	const records = await store.list("generic", { limit: 50, offset: 0 });
	// The user and assistant turns of the first two prompts, stamped with their content time.
	expect(records.map((record) => record.createdAt)).toEqual([
		"2026-01-02T09:00:00.000Z",
		"2026-01-02T09:00:00.000Z",
		"2026-01-02T10:00:00.000Z",
		"2026-01-02T10:00:00.000Z",
	]);
	expect(records.map((record) => record.text)).toEqual([
		"The widgets parser must reject trailing commas",
		"Done: the widgets parser rejects trailing commas now",
		"How do I run the widgets parser tests?",
		"Run them with bun test from the package root",
	]);
});

test("without a store URL the real run exits 2 naming it; --dry needs none; a transcript without timestamps exits 2", async () => {
	const noStore = await backfill([fixture], { HOME: "/home/test" });
	expect(noStore.code).toBe(2);
	expect(noStore.err).toContain("DMN_STORE_URL");

	// --dry never touches a store, so it needs no URL (checked without one, asserting the exit).
	const dryNoStore = await backfill(["--dry", fixture], { HOME: "/home/test" });
	expect(dryNoStore.code).toBe(0);

	const untimed = join(scratch, "untimed.jsonl");
	writeFileSync(
		untimed,
		`${JSON.stringify({
			type: "user",
			cwd: "/home/dev/acme/widgets",
			message: { role: "user", content: "no timestamp on this line" },
		})}\n`,
	);
	const badTime = await backfill(["--dry", untimed], { HOME: "/home/test" });
	expect(badTime.code).toBe(2);
	expect(badTime.err).toContain("untimed.jsonl: prompt 0 has no timestamp");
});

test("each transcript path gets its own line and cap, whatever the basenames", async () => {
	const one = join(scratch, "one");
	const two = join(scratch, "two");
	mkdirSync(one, { recursive: true });
	mkdirSync(two, { recursive: true });
	// The same basename in two directories, and a transcript that holds no prompt at all.
	writeFileSync(
		join(one, "live-a.jsonl"),
		exchange("2026-01-06T09:00:00.000Z", "one first") +
			exchange("2026-01-06T10:00:00.000Z", "one second"),
	);
	writeFileSync(join(two, "live-a.jsonl"), exchange("2026-01-06T09:30:00.000Z", "two only"));
	const empty = join(scratch, "empty.jsonl");
	writeFileSync(
		empty,
		`${JSON.stringify({
			type: "assistant",
			cwd: "/home/dev/acme/widgets",
			timestamp: "2026-01-06T09:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "no prompt before this" }] },
		})}\n`,
	);
	const dry = await backfill(
		["--dry", "--max-turns", "1", join(one, "live-a.jsonl"), join(two, "live-a.jsonl"), empty],
		{ DMN_STORE_URL: server.url, HOME: "/home/test" },
	);
	expect(dry.code).toBe(0);
	// One line per given path, each with its own --max-turns count; the empty one still lines.
	expect(dry.out.split("\n").filter(Boolean)).toEqual([
		`${join(one, "live-a.jsonl")}: prompts=1 retained=2 skipped=0`,
		`${join(two, "live-a.jsonl")}: prompts=1 retained=2 skipped=0`,
		`${empty}: prompts=0 retained=0 skipped=0`,
	]);
});
