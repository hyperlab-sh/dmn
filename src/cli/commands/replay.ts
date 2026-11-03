import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, createJudge, createStore, loadConfig } from "../../config/config.js";
import type { Manifest } from "../../cue/stack.js";
import { FakeJudge } from "../../judge/fake.js";
import type { Judge } from "../../judge/types.js";
import { judgeRun, MissingRunFileError } from "../../replay/judge.js";
import { readManifests } from "../../replay/manifests.js";
import { RunExistsError, readRunTop, writeReport } from "../../replay/report.js";
import { readSeedMemories, runName, runReplay, seedFakeStore } from "../../replay/run.js";
import { readJudgements, score, writeSummary } from "../../replay/score.js";
import { promptsFrom } from "../../replay/transcript.js";
import { LocalState } from "../../state/state.js";
import type { MemoryStore } from "../../store/types.js";

const usage = `Usage:
  dmn replay <transcript.jsonl>... [--store fake|<url>] [--out <dir>] [--top 5]
             [--memories <json>] [--manifests <dir>] [--judge fake|laya]
  dmn replay score <run-dir> [--top 5]
  dmn replay judge <run-dir> [--threshold <p>] [--judge fake|laya]
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
}

function parseArguments(argv: string[]): Options {
	const options: Options = { files: [] };
	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i] as string;
		if (!argument.startsWith("--")) {
			options.files.push(argument);
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
	const storeOption = options.store ?? process.env.DMN_STORE_URL;
	if (!storeOption) throw new UsageError("pass --store fake|<url> (or set DMN_STORE_URL)");
	const config = loadConfig({
		env: { ...process.env, DMN_STORE_URL: storeOption === "fake" ? "fake:" : storeOption },
	});
	const now = process.env.DMN_NOW ? new Date(process.env.DMN_NOW) : new Date();
	if (Number.isNaN(now.getTime())) throw new UsageError("DMN_NOW is not a date");
	const random = process.env.DMN_SEED ? seededRandom(process.env.DMN_SEED) : Math.random;

	let store: MemoryStore;
	if (config.storeUrl === "fake:") {
		const memories = options.memories ?? "fixtures/replay/memories.json";
		if (!existsSync(memories))
			throw new UsageError(`${memories} not found; pass --memories <json>`);
		store = await seedFakeStore(readSeedMemories(memories), now);
	} else {
		store = createStore(config);
	}
	const manifests: Manifest[] = options.manifests ? readManifests(options.manifests) : [];
	// Only an explicit --judge adds the third order: a configured provider alone does not make a
	// replay call the network.
	const judge = options.judge ? judgeFor(options.judge, config, process.env) : undefined;
	const prompts = options.files.flatMap((file) => promptsFrom(file));

	// Known before the replay starts: refuse early rather than after every store query.
	const directory = join(options.out ?? config.replayDir, runName(now));
	if (existsSync(directory)) throw new RunExistsError(directory);

	// A scratch state: replay must not touch the real use counts.
	const scratch = mkdtempSync(join(tmpdir(), "dmn-replay-"));
	const state = new LocalState({ directory: scratch, clock: () => now });
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
			...(judge && { judge, judgeThreshold: options.threshold ?? config.judge.threshold }),
		});
		writeReport(result, directory);
		for (const warning of result.warnings) process.stderr.write(`dmn: ${warning}\n`);
		console.log(`wrote ${join(directory, "report.md")} and ${join(directory, "judgements.json")}`);
		return 0;
	} finally {
		state.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** `dmn replay …`; returns the exit code. */
export async function run(argv: string[]): Promise<number> {
	try {
		if (argv[0] === "score") return scoreCommand(argv.slice(1));
		if (argv[0] === "judge") return await judgeCommand(argv.slice(1));
		return await replayCommand(argv);
	} catch (error) {
		if (
			error instanceof UsageError ||
			error instanceof ConfigError ||
			error instanceof RunExistsError ||
			error instanceof MissingRunFileError
		) {
			process.stderr.write(`dmn: ${error.message}\n\n${usage}`);
			return 2;
		}
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return 1;
	}
}
