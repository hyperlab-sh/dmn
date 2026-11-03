import { readFileSync } from "node:fs";
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

/** The as-live header: what the report says about the walk (D36). */
export interface LiveSummary {
	/** Where the use signal came from. */
	uses: "judged" | "none";
	/** ISO time prompts before which were seeding only, or null when every prompt was measured. */
	measureFrom: string | null;
	/** Prompts retained before `measureFrom`, never recalled, judged or reported. */
	seeded: number;
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
}

/**
 * The as-live walk (D36): prompts in timestamp order with the clock set to each one's time.
 * Recall at prompt N sees only what was retained before N; after the prompt is reported its
 * turns are retained with its timestamp, as the Stop hook would have; the sweep runs when the
 * replayed calendar day (UTC) changes and once more after the last prompt. Prompts before
 * `measureFrom` seed the store only, never measured.
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
}: LiveRunInput): Promise<ReplayResult> {
	if (live.uses === "judged" && !live.judge) throw new Error('live uses "judged" needs a judge');
	const utcDay = (at: Date) => at.toISOString().slice(0, 10);
	const sweepBanks = (cue: Cue) => [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	let lastDay: string | undefined;
	let seeded = 0;
	let lastAt = now;
	let lastCue: Cue | undefined;
	for (const prompt of prompts) {
		const at = new Date(prompt.at);
		if (Number.isNaN(at.getTime()))
			throw new Error(`prompt ${prompt.index} has no usable timestamp`);
		lastAt = at;
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
		if (lastDay !== undefined && utcDay(at) !== lastDay) {
			// The sweep of the night the replayed clock crossed into this day.
			await sweep({ store, state, config, banks: sweepBanks(cue), now: at });
		}
		lastDay = utcDay(at);
		if (live.measureFrom !== undefined && at < live.measureFrom) {
			// Seeding: retained with its own time, never recalled, judged or reported.
			seeded += 1;
			await retainPrompt(store, cue, prompt, prompt.answer ?? "", at);
			continue;
		}
		const entry = await measurePrompt({
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
		entries.push(entry);
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
		// The Stop hook's retain, at the prompt's own time: the next prompt can recall it.
		await retainPrompt(store, cue, prompt, prompt.answer ?? "", at);
	}
	// Once more, with the last replayed clock: the run ends like a day a live install swept.
	if (lastCue) await sweep({ store, state, config, banks: sweepBanks(lastCue), now: lastAt });
	return {
		run: runName(now),
		top,
		entries,
		warnings,
		live: {
			uses: live.uses,
			measureFrom: live.measureFrom?.toISOString() ?? null,
			seeded,
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
