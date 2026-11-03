import { parseArgs } from "node:util";
import { ConfigError, createStore, loadConfig } from "../../config/config.js";
import { buildCue } from "../../cue/cue.js";
import { orderPrompts, retainPrompt, UntimedPromptError } from "../../replay/live.js";
import { FakeStore } from "../../store/fake.js";
import type { MemoryStore } from "../../store/types.js";

const usage = `Usage:
  dmn backfill <transcript.jsonl>... [--max-turns <n>] [--dry]

Seeds the store from past sessions: each prompt's user and assistant turns are retained
through the same filter the Stop hook applies, stamped with the prompt's recorded time so
backfilled memories carry their content time, never the ingest time. --max-turns limits the
prompts taken per transcript (default 40). --dry prints what would be retained and writes
nothing; it needs no store. A retain the store rejects does not stop the run: the transcript's
line counts it as failed= and the walk goes on; the exit code is 1 only when nothing was
retained at all. Failed retains are not retried: the retry policy is Hindsight's own.
`;

/** What one transcript contributed: the line `--dry` and the report print. */
interface TranscriptTally {
	path: string;
	prompts: number;
	retained: number;
	/** Prompts whose retain the store rejected (D37); shown as `failed=` when above zero. */
	failed: number;
	skipped: Map<string, number>;
}

function lineOf(tally: TranscriptTally): string {
	const reasons = [...tally.skipped].map(([reason, count]) => ` ${reason}=${count}`).join("");
	const failed = tally.failed > 0 ? ` failed=${tally.failed}` : "";
	return `${tally.path}: prompts=${tally.prompts} retained=${tally.retained}${failed} skipped=${tally.skipped.size > 0 ? [...tally.skipped.values()].reduce((a, b) => a + b, 0) : 0}${reasons}`;
}

/** Runs `dmn backfill <transcripts...> [--max-turns <n>] [--dry]`; returns the exit code. */
export async function runBackfill(
	argv: string[],
	env: Record<string, string | undefined>,
): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(usage);
		return 0;
	}
	let parsed: { values: { "max-turns"?: string; dry?: boolean }; positionals: string[] };
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				"max-turns": { type: "string" },
				dry: { type: "boolean" },
			},
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		process.stderr.write(`dmn: backfill: ${(error as Error).message}\n\n${usage}`);
		return 2;
	}
	const { "max-turns": maxTurnsOption, dry } = parsed.values;
	const maxTurns = maxTurnsOption !== undefined ? Number(maxTurnsOption) : 40;
	if (!Number.isInteger(maxTurns) || maxTurns < 1) {
		process.stderr.write("dmn: backfill: --max-turns must be a positive integer\n");
		return 2;
	}
	const files = parsed.positionals;
	if (files.length === 0) {
		process.stderr.write(`dmn: backfill: no transcripts given\n\n${usage}`);
		return 2;
	}
	try {
		// Every prompt must carry its time before anything is retained (D36: the content time).
		const ordered = orderPrompts(files);
		const config = dry ? loadConfig({ env, requireStore: false }) : loadConfig({ env });
		const store: MemoryStore = dry ? new FakeStore() : createStore(config);
		// One line and one --max-turns count per given path: basenames may collide across
		// directories, and a transcript that holds no prompt still gets its line.
		const tally = new Map<string, TranscriptTally>(
			files.map((path) => [path, { path, prompts: 0, retained: 0, failed: 0, skipped: new Map() }]),
		);
		const taken = new Map<string, number>();
		let totalRetained = 0;
		let failedRetains = 0;
		for (const prompt of ordered) {
			const seen = taken.get(prompt.path) ?? 0;
			// At most --max-turns prompts per transcript; the rest are history left alone.
			if (seen >= maxTurns) continue;
			taken.set(prompt.path, seen + 1);
			const current = tally.get(prompt.path);
			if (!current) continue;
			current.prompts += 1;
			const cue = buildCue({
				cwd: prompt.cwd,
				manifests: [],
				...(prompt.activeSkill ? { activeSkill: prompt.activeSkill } : {}),
				recentTools: prompt.recentTools,
				organizations: config.organizations,
			});
			// A retain the store rejects is counted on its transcript's line and the walk goes on
			// (D37); it is never retried — the retry policy is Hindsight's own.
			try {
				const result = await retainPrompt(store, cue, prompt, prompt.answer, new Date(prompt.at));
				current.retained += result.retained;
				totalRetained += result.retained;
				for (const { reason } of result.skipped) {
					current.skipped.set(reason, (current.skipped.get(reason) ?? 0) + 1);
				}
			} catch {
				current.failed += 1;
				failedRetains += 1;
			}
		}
		for (const current of tally.values()) process.stdout.write(`${lineOf(current)}\n`);
		if (!dry) process.stdout.write(`total retained ${totalRetained}\n`);
		// Nothing landed at all and at least one retain failed: the run seeded nothing, so say
		// so and fail. Skips alone (secrets) are a filter verdict, not a failure.
		if (!dry && failedRetains > 0 && totalRetained === 0) {
			process.stderr.write("dmn: backfill: nothing was retained\n");
			return 1;
		}
		return 0;
	} catch (error) {
		if (error instanceof UntimedPromptError) {
			process.stderr.write(`dmn: backfill: ${error.message}\n\n${usage}`);
			return 2;
		}
		if (error instanceof ConfigError) {
			process.stderr.write(`dmn: ${(error as Error).message}\n`);
			return 2;
		}
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return 1;
	}
}
