import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config/config.js";
import { buildCue, type Cue, softTags } from "../cue/cue.js";
import type { Manifest } from "../cue/stack.js";
import type { Judge } from "../judge/types.js";
import { judgeGate, recall, recallQuery } from "../recall/pipeline.js";
import type { RankedMemory } from "../recall/rerank.js";
import type { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import { bankFor } from "../store/hindsight.js";
import type { MemoryRecord, MemoryStore } from "../store/types.js";
import { sweep } from "../sweep/sweep.js";
import { recordJudgedUses, retainPrompt } from "./live.js";
import type { ReplayPrompt } from "./transcript.js";

export interface ReplayEntry {
	/** One-based over the whole run, across transcripts; the `prompt` of a judgement. */
	number: number;
	prompt: ReplayPrompt;
	cue: Cue;
	/** The store's own order, banks merged by score. */
	store: MemoryRecord[];
	/** The activation order the hooks would inject. */
	activation: RankedMemory[];
	/** With a judge: the activation order through the gate at `judgeThreshold`, then top-N. */
	judged?: RankedMemory[];
	/** The judge's answer for each memory it answered, by id. */
	judgements?: Record<string, { useful: number; level: number }>;
}

export interface ReplayResult {
	/** Directory name for this run, derived from `now`. */
	run: string;
	top: number;
	entries: ReplayEntry[];
	/** Non-fatal problems met on the way (a bank whose tag counts failed). */
	warnings: string[];
	/** Present only for an as-live run: the header rows its report carries. */
	live?: LiveSummary;
}

/** The as-live header: what the report says about the walk (D36, D40). */
export interface LiveSummary {
	/** Where the use signal came from. */
	uses: "judged" | "none";
	/** ISO time prompts before which were seeding only, or null when every prompt was measured. */
	measureFrom: string | null;
	/** Prompts retained as seeding over every run into this `--out`, never recalled or reported. */
	seeded: number;
	/** Present when the walk stopped on consecutive failures (D40): the checkpoint and report were still written. */
	stopped?: { failures: number; lastError: string };
}

/** The as-live walk's checkpoint (D40): what a walk into an `--out` has done so far, so a later
 * invocation with the same `--out` continues where this one stopped instead of starting over. */
export interface LiveCheckpoint {
	version: 1;
	/** What the walk was made with; resuming with other values is a usage error. */
	settings: { measureFrom: string | null; uses: "judged" | "none"; top: number };
	/** ISO time of the last prompt covered: what an out-of-order resumed prompt is older than. */
	lastAt: string;
	/** Keys `<basename>:<index>` of the prompts retained as seeding. */
	seeded: string[];
	/** Keys `<basename>:<index>` of the prompts measured (an entry exists for each). */
	measured: string[];
	/** The entries measured so far, in timestamp order. */
	entries: ReplayEntry[];
}

/** Name of the checkpoint file inside the as-live walk's `--out`. */
export const checkpointFile = "checkpoint.json";

/** A checkpoint dmn cannot resume: corrupt, or written by something else. */
export class CheckpointError extends Error {
	constructor(path: string, because: string) {
		super(`${path}: ${because}; remove it or resume into another --out`);
		this.name = "CheckpointError";
	}
}

/** The checkpoint of one walk, as serialized in `--out`. */
function formatCheckpoint(checkpoint: LiveCheckpoint): string {
	return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

/** Reads a checkpoint, refusing anything dmn did not write: a silently truncated resume would
 * re-walk a store the operator already paid for. */
export function parseCheckpoint(raw: string, path: string): LiveCheckpoint {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CheckpointError(path, "not valid JSON");
	}
	const bad = (because: string): never => {
		throw new CheckpointError(path, because);
	};
	if (typeof parsed !== "object" || parsed === null) bad("not a checkpoint");
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) bad(`version ${JSON.stringify(record.version)} is not 1`);
	const settings = record.settings;
	if (typeof settings !== "object" || settings === null) bad("no settings");
	const { measureFrom, uses, top } = settings as Record<string, unknown>;
	if (measureFrom !== null && typeof measureFrom !== "string")
		bad("settings.measureFrom is not a time");
	if (uses !== "judged" && uses !== "none") bad("settings.uses is not judged or none");
	if (typeof top !== "number" || !Number.isInteger(top) || top < 1)
		bad("settings.top is not a positive integer");
	if (typeof record.lastAt !== "string" || Number.isNaN(Date.parse(record.lastAt)))
		bad("lastAt is not a time");
	const isKeyList = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((key) => typeof key === "string");
	if (!isKeyList(record.seeded)) bad("seeded is not a list of prompt keys");
	if (!isKeyList(record.measured)) bad("measured is not a list of prompt keys");
	if (
		!Array.isArray(record.entries) ||
		!record.entries.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as { prompt?: { at?: unknown } }).prompt?.at === "string",
		)
	)
		bad("entries is not a list of measured entries");
	return parsed as LiveCheckpoint;
}

/** Writes a checkpoint, creating `--out` on the first prompt of a fresh walk (D40). */
export function writeCheckpoint(path: string, checkpoint: LiveCheckpoint): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, formatCheckpoint(checkpoint));
}

/** The as-live walk's settings (D36). */
export interface LiveOptions {
	/** Prompts before this time are retained only: seeding, never measured. */
	measureFrom?: Date;
	/** `judged`: a shown memory the judge calls useful counts as used (needs `judge`). */
	uses: "judged" | "none";
	/** The judge of the use signal; required when `uses` is "judged". */
	judge?: Judge;
	/** Set to each prompt's time before every step, so state stamps carry the replayed clock. */
	clock: { set(now: Date): void };
	/** The walk stops after this many prompts in a row with a failed retain or recall (D40). */
	maxConsecutiveFailures?: number;
	/** The checkpoint resumed from, when `--out` already holds one: its prompts are skipped (D40). */
	checkpoint?: LiveCheckpoint;
	/** Called with the checkpoint after every walked prompt; the caller persists it (D40). */
	onCheckpoint?: (checkpoint: LiveCheckpoint) => void;
	/** Sees one line every 25 walked prompts and when a transcript completes (D40). */
	onProgress?: (line: string) => void;
	/** Wall clock the progress line's elapsed time reads; defaults to the real one (C-7). */
	nowMs?: () => number;
}

export interface ReplayOptions {
	prompts: ReplayPrompt[];
	store: MemoryStore;
	state: LocalState;
	config: Config;
	top: number;
	random: () => number;
	now: Date;
	/** Manifests of the project the transcripts came from; none when omitted. */
	manifests?: Manifest[];
	/** Adds the `activation+judge` list; the judge sees one batch per prompt. */
	gate?: { judge: Judge; threshold: number };
	/** Replays time instead of reading a seeded store: the D36 walk. */
	live?: LiveOptions;
}

/** Candidates in the store's own order: each bank's results merged by score, ties by bank order. */
async function storeOrder(
	store: MemoryStore,
	config: Config,
	cue: Cue,
	query: string,
	tags: string[],
): Promise<MemoryRecord[]> {
	const banks = [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	const perBank = await Promise.all(
		banks.map((bank) => store.recall(bank, { query, tags, tagsMatch: "any", topK: config.topK })),
	);
	const seen = new Set<string>();
	const merged: MemoryRecord[] = [];
	for (const memory of perBank.flat()) {
		if (seen.has(memory.id)) continue;
		seen.add(memory.id);
		merged.push(memory);
	}
	return merged.sort((a, b) => (b.score?.final ?? 0) - (a.score?.final ?? 0));
}

/** Directory name of the run made at `now`. */
export function runName(now: Date): string {
	return `run-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/** Everything the report says about one prompt, in both orders; shared by both modes. */
interface MeasureInput {
	cue: Cue;
	prompt: ReplayPrompt;
	store: MemoryStore;
	state: LocalState;
	config: Config;
	top: number;
	random: () => number;
	now: Date;
	gate?: ReplayOptions["gate"];
	number: number;
	warnings: string[];
}

async function measurePrompt({
	cue,
	prompt,
	store,
	state,
	config,
	top,
	random,
	now,
	gate,
	number,
	warnings,
}: MeasureInput): Promise<ReplayEntry> {
	const ranked = await recall({
		store,
		state,
		config,
		cue,
		prompt: prompt.text,
		onFanError: (bank, error) =>
			warnings.push(`tag counts of bank ${bank} unavailable: ${(error as Error).message}`),
		random,
		now,
	});
	const query = recallQuery(prompt.text, cue);
	const byStore = await storeOrder(store, config, cue, query, softTags(cue));
	const gated = gate
		? await judgeGate(ranked, query, gate.judge, gate.threshold, (error) =>
				warnings.push(`judge: ${(error as Error).message}`),
			)
		: undefined;
	const dormant = (memory: MemoryRecord) => state.isDormant(memory.id);
	return {
		number,
		prompt,
		cue,
		store: byStore.filter((memory) => !dormant(memory)).slice(0, top),
		activation: ranked.slice(0, top),
		...(gated && {
			judged: gated.kept.slice(0, top),
			judgements: Object.fromEntries(
				Object.entries(gated.answers).map(([id, { useful, level }]) => [id, { useful, level }]),
			),
		}),
	};
}

/** Runs every prompt through recall twice: in the store's order and in activation order. Read-only. */
export async function runReplay({
	prompts,
	store,
	state,
	config,
	top,
	random,
	now,
	manifests,
	gate,
	live,
}: ReplayOptions): Promise<ReplayResult> {
	const warnings: string[] = [];
	const entries: ReplayEntry[] = [];
	if (live) {
		return runLiveReplay({
			prompts,
			store,
			state,
			config,
			top,
			random,
			now,
			manifests,
			gate,
			live,
			warnings,
			entries,
			nowMs: live.nowMs,
		});
	}
	// Sequential: the injected random stream is consumed in a fixed order.
	for (const prompt of prompts) {
		// The recorded directory may not exist here, so no scan: only what the transcript says.
		const cue = buildCue({
			cwd: prompt.cwd,
			manifests: manifests ?? [],
			...(prompt.activeSkill ? { activeSkill: prompt.activeSkill } : {}),
			recentTools: prompt.recentTools,
			organizations: config.organizations,
		});
		entries.push(
			await measurePrompt({
				cue,
				prompt,
				store,
				state,
				config,
				top,
				random,
				now,
				gate,
				number: entries.length + 1,
				warnings,
			}),
		);
	}
	return { run: runName(now), top, entries, warnings };
}

interface LiveRunInput {
	prompts: ReplayPrompt[];
	store: MemoryStore;
	state: LocalState;
	config: Config;
	top: number;
	random: () => number;
	now: Date;
	manifests?: Manifest[] | undefined;
	gate?: ReplayOptions["gate"];
	live: LiveOptions;
	warnings: string[];
	entries: ReplayEntry[];
	/** The wall clock of the progress line; injected so a test needs no real one (C-7). */
	nowMs?: (() => number) | undefined;
}

/** One prompt of the walk, keyed the way the checkpoint and the retain documents key it. */
const promptKey = (prompt: ReplayPrompt) => `${prompt.file ?? "transcript"}:${prompt.index}`;

/** `mm:ss` since the walk started, for the progress line (D40). */
function elapsedSince(startedAt: number, nowMs: () => number): string {
	const seconds = Math.floor((nowMs() - startedAt) / 1000);
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The as-live walk (D36, D40): prompts in timestamp order with the clock set to each one's time.
 * Recall at prompt N sees only what was retained before N; after the prompt is reported its
 * turns are retained with its timestamp, as the Stop hook would have; the sweep runs when the
 * replayed calendar day (UTC) changes and once more after the last prompt. Prompts before
 * `measureFrom` seed the store only, never measured. A checkpoint in `live` resumes the walk:
 * its prompts are skipped — never recalled, judged or retained again — and its entries are
 * reported beside the new ones. A prompt whose store calls fail costs a warning; after
 * `maxConsecutiveFailures` failed prompts in a row the walk stops, with the checkpoint and the
 * entries so far still returned for the report.
 */
async function runLiveReplay({
	prompts,
	store,
	state,
	config,
	top,
	random,
	now,
	manifests,
	gate,
	live,
	warnings,
	entries,
	nowMs = () => Date.now(),
}: LiveRunInput): Promise<ReplayResult> {
	if (live.uses === "judged" && !live.judge) throw new Error('live uses "judged" needs a judge');
	const utcDay = (at: Date) => at.toISOString().slice(0, 10);
	const sweepBanks = (cue: Cue) => [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	// The message of the most recent failure, for the stop line (D40).
	let lastFailure = "";
	/**
	 * One prompt's retain; a store that rejects it (an error, a timeout, an HTTP 4xx/5xx from
	 * Hindsight) costs a warning naming the transcript, the prompt index and the message, and
	 * the walk goes on. Never retried: the retry policy is Hindsight's own (D37). Returns
	 * whether the retain landed, for the consecutive-failure counter (D40).
	 */
	const retainOrWarn = async (prompt: ReplayPrompt, cue: Cue, at: Date): Promise<boolean> =>
		await retainPrompt(store, cue, prompt, prompt.answer ?? "", at).then(
			() => true,
			(error: unknown) => {
				lastFailure = (error as Error).message;
				warnings.push(
					`retain failed ${prompt.file ?? "transcript"}#${prompt.index}: ${lastFailure}`,
				);
				return false;
			},
		);
	// The walk resumed from (D40): its prompts are done and its entries come first.
	const checkpoint = live.checkpoint;
	const seededKeys = new Set(checkpoint?.seeded ?? []);
	const measuredKeys = new Set(checkpoint?.measured ?? []);
	const checkpointedKeys = new Set([...seededKeys, ...measuredKeys]);
	if (checkpoint) entries.push(...checkpoint.entries);
	// What the resumed prompts already covered: a prompt walked now that is older than this was
	// never seen by the measurements before it, which the warning says (D40).
	const checkpointAt = checkpoint ? new Date(checkpoint.lastAt) : undefined;
	// Progress and failure accounting (this invocation only, D40): the line shows the run moving.
	const limit = live.maxConsecutiveFailures ?? 5;
	const startedAt = nowMs();
	const remaining = prompts.filter((prompt) => !checkpointedKeys.has(promptKey(prompt))).length;
	let done = 0;
	let seededThisRun = 0;
	let measuredThisRun = 0;
	let failedThisRun = 0;
	let consecutiveFailed = 0;
	let stopped: { failures: number; lastError: string } | undefined;
	// A transcript's boundary is its last prompt in the merged walk: the line marks it finished.
	const lastIndexOf = new Map<string, number>();
	prompts.forEach((prompt, index) => {
		lastIndexOf.set(prompt.file ?? "transcript", index);
	});
	const emitProgress = () =>
		live.onProgress?.(
			`progress ${done}/${remaining} prompts, ${seededThisRun} seeded, ${measuredThisRun} measured, ${failedThisRun} failed, ${elapsedSince(startedAt, nowMs)} elapsed`,
		);
	const saveCheckpoint = (lastWalked: Date) =>
		live.onCheckpoint?.({
			version: 1,
			settings: { measureFrom: live.measureFrom?.toISOString() ?? null, uses: live.uses, top },
			lastAt: lastWalked.toISOString(),
			seeded: [...seededKeys],
			measured: [...measuredKeys],
			entries,
		});
	let lastDay: string | undefined;
	let lastWalkedAt = now;
	// The furthest time any run into this `--out` has walked to: what the next checkpoint says.
	let furthest = checkpointAt;
	let lastCue: Cue | undefined;
	for (const [position, prompt] of prompts.entries()) {
		const at = new Date(prompt.at);
		if (Number.isNaN(at.getTime()))
			throw new Error(`prompt ${prompt.index} has no usable timestamp`);
		const key = promptKey(prompt);
		if (checkpointedKeys.has(key)) continue;
		if (checkpointAt !== undefined && at < checkpointAt) {
			warnings.push(
				`out of order: ${prompt.file ?? "transcript"}#${prompt.index} (${at.toISOString()}) is older than the checkpoint (${checkpointAt.toISOString()}); measurements before it did not see it`,
			);
		}
		if (furthest === undefined || at > furthest) furthest = at;
		live.clock.set(at);
		// The recorded directory may not exist here, so no scan: only what the transcript says.
		const cue = buildCue({
			cwd: prompt.cwd,
			manifests: manifests ?? [],
			...(prompt.activeSkill ? { activeSkill: prompt.activeSkill } : {}),
			recentTools: prompt.recentTools,
			organizations: config.organizations,
		});
		lastCue = cue;
		lastWalkedAt = at;
		if (lastDay !== undefined && utcDay(at) !== lastDay) {
			// The sweep of the night the replayed clock crossed into this day.
			await sweep({ store, state, config, banks: sweepBanks(cue), now: at });
		}
		lastDay = utcDay(at);
		// A prompt fails when any of its store calls failed: recalls that succeed between failing
		// prompts do not reset the run, so a provider that only retains badly still stops the walk.
		let failed = false;
		if (live.measureFrom !== undefined && at < live.measureFrom) {
			// Seeding: retained with its own time, never recalled, judged or reported. The prompt
			// counts as seeded whatever its retain does — a failure is a warning, not a shorter walk.
			seededKeys.add(key);
			seededThisRun += 1;
			if (!(await retainOrWarn(prompt, cue, at))) failed = true;
		} else {
			let entry: ReplayEntry | undefined;
			try {
				entry = await measurePrompt({
					cue,
					prompt,
					store,
					state,
					config,
					top,
					random,
					now: at,
					gate,
					number: entries.length + 1,
					warnings,
				});
			} catch (error) {
				// A recall the store could not answer (a store error, a timeout) costs this prompt's
				// measurement — a warning, no entry — but not the walk: its turns are still retained
				// below, so the next prompt recalls them (D40).
				lastFailure = (error as Error).message;
				failed = true;
				warnings.push(
					`recall failed ${prompt.file ?? "transcript"}#${prompt.index}: ${lastFailure}`,
				);
			}
			if (entry) {
				entries.push(entry);
				measuredKeys.add(key);
				measuredThisRun += 1;
				if (live.uses === "judged" && live.judge) {
					await recordJudgedUses(
						state,
						live.judge,
						config.judge.threshold,
						recallQuery(prompt.text, entry.cue),
						entry.activation,
						entry.cue.project,
						`live:${prompt.file ?? "transcript"}:${prompt.index}`,
						(error) => warnings.push(`judge: ${(error as Error).message}`),
					);
				}
			}
			// The Stop hook's retain, at the prompt's own time: the next prompt can recall it. A
			// failed one is reported above and skipped; later prompts recall what did land (D37).
			if (!(await retainOrWarn(prompt, cue, at))) failed = true;
		}
		done += 1;
		if (failed) {
			consecutiveFailed += 1;
			failedThisRun += 1;
		} else {
			consecutiveFailed = 0;
		}
		// A line every 25 walked prompts and when a transcript finishes; the checkpoint follows.
		if (done % 25 === 0 || lastIndexOf.get(prompt.file ?? "transcript") === position)
			emitProgress();
		if (furthest !== undefined) saveCheckpoint(furthest);
		if (consecutiveFailed >= limit) {
			stopped = { failures: consecutiveFailed, lastError: lastFailure };
			break;
		}
	}
	// Once more, with the last replayed clock: the run ends like a day a live install swept. A
	// walk stopped on failures did not end its day (D40); the resumed one sweeps on the change.
	if (!stopped && lastCue)
		await sweep({ store, state, config, banks: sweepBanks(lastCue), now: lastWalkedAt });
	// The report is over every entry of this --out, in timestamp order (D40): a resumed older
	// transcript can land before entries already numbered, so the numbers follow the order.
	entries.sort((a, b) => Date.parse(a.prompt.at) - Date.parse(b.prompt.at));
	for (const [index, entry] of entries.entries()) entry.number = index + 1;
	if (furthest !== undefined) saveCheckpoint(furthest);
	return {
		run: runName(now),
		top,
		entries,
		warnings,
		live: {
			uses: live.uses,
			measureFrom: live.measureFrom?.toISOString() ?? null,
			// Over every run into this --out: the checkpointed seeds and this run's (D40).
			seeded: seededKeys.size,
			...(stopped && { stopped }),
		},
	};
}

export interface SeedMemory {
	/** Organization name, or `generic`. */
	bank: string;
	tags: string[];
	text: string;
	createdAt?: string;
}

export function readSeedMemories(path: string): SeedMemory[] {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	const valid =
		Array.isArray(parsed) &&
		parsed.every(
			(item) =>
				item &&
				typeof item.bank === "string" &&
				typeof item.text === "string" &&
				Array.isArray(item.tags) &&
				item.tags.every((tag: unknown) => typeof tag === "string"),
		);
	if (!valid) throw new Error(`${path}: expected a list of {bank, tags, text}`);
	return parsed as SeedMemory[];
}

/** An in-process store holding `memories`. The only retain in the harness (C-6). */
export async function seedFakeStore(memories: SeedMemory[], now: Date): Promise<FakeStore> {
	let clock = now;
	const store = new FakeStore(() => clock);
	for (const memory of memories) {
		clock = memory.createdAt ? new Date(memory.createdAt) : now;
		await store.retain(bankFor(memory.bank), [{ content: memory.text, tags: memory.tags }]);
	}
	return store;
}
