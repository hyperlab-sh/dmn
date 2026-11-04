import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, createJudge, createStore, loadConfig } from "../../config/config.js";
import type { Manifest } from "../../cue/stack.js";
import { FakeJudge } from "../../judge/fake.js";
import type { Judge } from "../../judge/types.js";
import { judgeRun, MissingRunFileError } from "../../replay/judge.js";
import { orderPrompts, UntimedPromptError } from "../../replay/live.js";
import { readManifests } from "../../replay/manifests.js";
import { RunExistsError, readRunTop, writeReport } from "../../replay/report.js";
import {
	CheckpointError,
	checkpointFile,
	type LiveCheckpoint,
	parseCheckpoint,
	readSeedMemories,
	runName,
	runReplay,
	seedFakeStore,
	writeCheckpoint,
} from "../../replay/run.js";
import { readJudgements, score, writeSummary } from "../../replay/score.js";
import { promptsFrom } from "../../replay/transcript.js";
import { LocalState } from "../../state/state.js";
import { FakeStore } from "../../store/fake.js";
import type { MemoryStore } from "../../store/types.js";

const usage = `Usage:
  dmn replay <transcript.jsonl>... [--store fake|<url>] [--out <dir>] [--top 5]
             [--memories <json>] [--manifests <dir>] [--judge fake|laya] [--threshold <p>]
             [--as-live [--measure-from <iso>] [--uses judged|none] [--max-consecutive-failures <n>]]
  dmn replay score <run-dir> [--top 5]
  dmn replay judge <run-dir> [--threshold <p>] [--judge fake|laya]

--as-live replays time: prompts walk in timestamp order with the clock set to each one's
  time, turns are retained as the Stop hook would have, and --uses judged (the default;
  needs --judge) counts a shown memory the judge calls useful as used. --measure-from
  <iso> retains-only the prompts before it, seeding the store from history. The walk keeps
  a checkpoint in --out after every prompt (a rerun into the same --out resumes it), stops
  after --max-consecutive-failures <n> prompts in a row whose store calls failed (default 5),
  and prints a progress line to stderr every 25 prompts and when a transcript completes.
`;

class UsageError extends Error {}

interface Options {
	files: string[];
	store?: string;
	out?: string;
	top?: number;
	memories?: string;
	manifests?: string;
	threshold?: number;
	judge?: "fake" | "laya";
	asLive?: boolean;
	uses?: "judged" | "none";
	measureFrom?: Date;
	maxConsecutiveFailures?: number;
}

function parseArguments(argv: string[]): Options {
	const options: Options = { files: [] };
	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i] as string;
		if (!argument.startsWith("--")) {
			options.files.push(argument);
			continue;
		}
		if (argument === "--as-live") {
			options.asLive = true;
			continue;
		}
		const value = argv[++i];
		if (value === undefined) throw new UsageError(`${argument} needs a value`);
		switch (argument) {
			case "--store":
				options.store = value;
				break;
			case "--out":
				options.out = value;
				break;
			case "--memories":
				options.memories = value;
				break;
			case "--manifests":
				options.manifests = value;
				break;
			case "--threshold": {
				const threshold = Number(value);
				if (!(threshold >= 0 && threshold <= 1))
					throw new UsageError("--threshold must be a number from 0 to 1");
				options.threshold = threshold;
				break;
			}
			case "--judge":
				if (value !== "fake" && value !== "laya")
					throw new UsageError("--judge must be fake or laya");
				options.judge = value;
				break;
			case "--uses":
				if (value !== "judged" && value !== "none")
					throw new UsageError("--uses must be judged or none");
				options.uses = value;
				break;
			case "--measure-from": {
				const at = new Date(value);
				if (Number.isNaN(at.getTime())) throw new UsageError("--measure-from is not a date");
				options.measureFrom = at;
				break;
			}
			case "--max-consecutive-failures": {
				const count = Number(value);
				if (!Number.isInteger(count) || count < 1)
					throw new UsageError("--max-consecutive-failures must be a positive integer");
				options.maxConsecutiveFailures = count;
				break;
			}
			case "--top": {
				const top = Number(value);
				if (!Number.isInteger(top) || top < 1)
					throw new UsageError("--top must be a positive integer");
				options.top = top;
				break;
			}
			default:
				throw new UsageError(`unknown option ${argument}`);
		}
	}
	return options;
}

/** Seeded generator (mulberry32) so `DMN_SEED` makes the noise reproducible. */
function seededRandom(seed: string): () => number {
	let hash = 2166136261;
	for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	let state = hash >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function scoreCommand(argv: string[]): number {
	const { files, top: override } = parseArguments(argv);
	const [directory] = files;
	if (!directory || files.length > 1) throw new UsageError("score takes exactly one run directory");
	const judgements = readJudgements(join(directory, "judgements.json"));
	// The run's own top unless overridden: dividing by another n would misreport both orders.
	const top = override ?? readRunTop(directory) ?? 5;
	const result = score(judgements, top);
	writeSummary(directory, { ...result, total: judgements.length, top });
	console.log(`store p@${top} = ${result.store.toFixed(2)}`);
	console.log(`activation p@${top} = ${result.activation.toFixed(2)}`);
	if (result.judged_order !== undefined) {
		console.log(`activation+judge p@${top} = ${result.judged_order.toFixed(2)}`);
	}
	console.log(`judged ${result.judged}/${judgements.length}`);
	return 0;
}

/** The judge `--judge` names, else the configured one; undefined when neither is set. */
function judgeFor(
	flag: "fake" | "laya" | undefined,
	config: ReturnType<typeof loadConfig>,
	env: Record<string, string | undefined>,
): Judge | undefined {
	if (flag === "fake") return new FakeJudge();
	const provider = flag ?? config.judge.provider;
	return createJudge({ ...config, judge: { ...config.judge, provider } }, env);
}

async function judgeCommand(argv: string[]): Promise<number> {
	const options = parseArguments(argv);
	const [directory] = options.files;
	if (!directory || options.files.length > 1) {
		throw new UsageError("judge takes exactly one run directory");
	}
	const env = process.env;
	// The judge never touches the store.
	const config = loadConfig({ env, requireStore: false });
	const judge = judgeFor(options.judge, config, env);
	if (!judge) {
		throw new UsageError(
			'no judge is configured; pass --judge fake|laya or set "judge": {"provider": "laya"} in config.json',
		);
	}
	const threshold = options.threshold ?? config.judge.threshold;
	const { judged, total, error } = await judgeRun(directory, judge, threshold);
	console.log(`judged ${judged}/${total}`);
	if (error) {
		// Answers already paid for are on disk; running the command again resumes.
		process.stderr.write(`dmn: ${error.message}\n`);
		return 1;
	}
	return 0;
}

async function replayCommand(argv: string[]): Promise<number> {
	const options = parseArguments(argv);
	if (options.files.length === 0) throw new UsageError("no transcripts given");
	if (
		(options.uses !== undefined ||
			options.measureFrom !== undefined ||
			options.maxConsecutiveFailures !== undefined) &&
		!options.asLive
	) {
		throw new UsageError("--uses, --measure-from and --max-consecutive-failures need --as-live");
	}
	const uses = options.uses ?? "judged";
	if (options.asLive && uses === "judged" && !options.judge) {
		throw new UsageError("--as-live --uses judged needs --judge fake|laya (or pass --uses none)");
	}
	const storeOption = options.store ?? process.env.DMN_STORE_URL;
	if (!storeOption) throw new UsageError("pass --store fake|<url> (or set DMN_STORE_URL)");
	const config = loadConfig({
		env: { ...process.env, DMN_STORE_URL: storeOption === "fake" ? "fake:" : storeOption },
	});
	const now = process.env.DMN_NOW ? new Date(process.env.DMN_NOW) : new Date();
	if (Number.isNaN(now.getTime())) throw new UsageError("DMN_NOW is not a date");
	const random = process.env.DMN_SEED ? seededRandom(process.env.DMN_SEED) : Math.random;
	// The as-live walk needs every prompt placed in time: refuse before anything is retained.
	const prompts = options.asLive
		? orderPrompts(options.files)
		: options.files.flatMap((file) => promptsFrom(file));

	// The walk's clock starts at the run's now; the live option moves it before every step.
	let clockNow = now;
	let store: MemoryStore;
	if (config.storeUrl === "fake:") {
		if (options.asLive && !options.memories) {
			// An as-live run measures the store the walk itself builds: seeding the dated fixture
			// memories would recall later content at earlier prompts (AC 3). Pass --memories to
			// start from a chosen set anyway.
			store = new FakeStore(() => clockNow);
		} else {
			const memories = options.memories ?? "fixtures/replay/memories.json";
			if (!existsSync(memories))
				throw new UsageError(`${memories} not found; pass --memories <json>`);
			store = await seedFakeStore(readSeedMemories(memories), now);
		}
	} else {
		store = createStore(config);
	}
	const manifests: Manifest[] = options.manifests ? readManifests(options.manifests) : [];
	// Only an explicit --judge adds the third order: a configured provider alone does not make
	// a replay call the network. In --as-live the judge named by --judge is the use signal's
	// (D36), not a third order.
	const judge = options.judge ? judgeFor(options.judge, config, process.env) : undefined;

	// Known before the replay starts: refuse early rather than after every store query. An
	// as-live run with a checkpoint in --out resumes it (D40): the walked prompts are skipped,
	// the report is written over all entries. Any other existing run directory is still refused.
	const outDirectory = options.out ?? config.replayDir;
	const directory = join(outDirectory, runName(now));
	const checkpointPath = join(outDirectory, checkpointFile);
	let checkpoint: LiveCheckpoint | undefined;
	if (options.asLive && existsSync(checkpointPath)) {
		checkpoint = parseCheckpoint(readFileSync(checkpointPath, "utf8"), checkpointPath);
		const settings = {
			measureFrom: options.measureFrom?.toISOString() ?? null,
			uses,
			top: options.top ?? 5,
		};
		const resumed = checkpoint.settings;
		if (
			resumed.measureFrom !== settings.measureFrom ||
			resumed.uses !== settings.uses ||
			resumed.top !== settings.top
		) {
			throw new UsageError(
				`the checkpoint in ${outDirectory} was made with --measure-from ${resumed.measureFrom ?? "none"}, --uses ${resumed.uses} and --top ${resumed.top}; resume with those or choose another --out`,
			);
		}
	} else if (existsSync(directory)) {
		throw new RunExistsError(directory);
	}

	// A scratch state: replay must not touch the real use counts.
	const scratch = mkdtempSync(join(tmpdir(), "dmn-replay-"));
	const state = new LocalState({ directory: scratch, clock: () => clockNow });
	try {
		const result = await runReplay({
			prompts,
			store,
			state,
			config,
			top: options.top ?? 5,
			random,
			now,
			manifests,
			...(judge &&
				!options.asLive && {
					gate: { judge, threshold: options.threshold ?? config.judge.threshold },
				}),
			...(options.asLive && {
				live: {
					uses,
					// The walk moves this clock before every step; state stamps follow the prompt.
					clock: {
						set: (at: Date) => {
							clockNow = at;
						},
					},
					...(judge && { judge }),
					...(options.measureFrom !== undefined && { measureFrom: options.measureFrom }),
					maxConsecutiveFailures: options.maxConsecutiveFailures ?? 5,
					...(checkpoint && { checkpoint }),
					onCheckpoint: (saved: LiveCheckpoint) => writeCheckpoint(checkpointPath, saved),
					onProgress: (line: string) => process.stderr.write(`${line}\n`),
				},
			}),
		});
		writeReport(result, directory, checkpoint ? { overwrite: true } : undefined);
		for (const warning of result.warnings) process.stderr.write(`dmn: ${warning}\n`);
		if (result.live?.stopped) {
			// The walk ended on --max-consecutive-failures (D40): the report of what was measured
			// so far is on disk; this one line says why the walk stopped, with the count and error.
			process.stderr.write(
				`dmn: stopped after ${result.live.stopped.failures} consecutive failures: ${result.live.stopped.lastError}\n`,
			);
			return 1;
		}
		process.stdout.write(
			`wrote ${join(directory, "report.md")} and ${join(directory, "judgements.json")}\n`,
		);
		return 0;
	} finally {
		state.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** `dmn replay …`; returns the exit code. */
export async function run(argv: string[]): Promise<number> {
	try {
		if (argv.includes("--help") || argv.includes("-h")) {
			process.stdout.write(usage);
			return 0;
		}
		if (argv[0] === "score") return scoreCommand(argv.slice(1));
		if (argv[0] === "judge") return await judgeCommand(argv.slice(1));
		return await replayCommand(argv);
	} catch (error) {
		if (
			error instanceof UsageError ||
			error instanceof ConfigError ||
			error instanceof RunExistsError ||
			error instanceof MissingRunFileError ||
			error instanceof UntimedPromptError ||
			error instanceof CheckpointError
		) {
			process.stderr.write(`dmn: ${error.message}\n\n${usage}`);
			return 2;
		}
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return 1;
	}
}
