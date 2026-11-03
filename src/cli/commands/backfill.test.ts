import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
afterAll(() => server.stop());

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
	const dry = await backfill(["--dry", fixture, secret], { HOME: "/home/test" });
	expect(dry.code).toBe(0);
	// One line per transcript: the fixture retains everything, the secret answer is skipped.
	expect(dry.out.split("\n").filter(Boolean)).toEqual([
		`${fixture}: prompts=3 retained=6 skipped=0`,
		`${secret}: prompts=1 retained=1 skipped=1 secret=1`,
	]);
	// Nothing was retained: the server's bank stays empty (no DMN_STORE_URL was even set).
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

test("without a store URL the real run exits 2 naming it; a transcript without timestamps too", async () => {
	const noStore = await backfill([fixture], { HOME: "/home/test" });
	expect(noStore.code).toBe(2);
	expect(noStore.err).toContain("DMN_STORE_URL");

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
