import { readFileSync } from "node:fs";
import type { Config } from "../config/config.js";
import { buildCue, type Cue, cueText, softTags } from "../cue/cue.js";
import type { Manifest } from "../cue/stack.js";
import type { Judge } from "../judge/types.js";
import { judgeGate, recall } from "../recall/pipeline.js";
import type { RankedMemory } from "../recall/rerank.js";
import type { LocalState } from "../state/state.js";
import { FakeStore } from "../store/fake.js";
import { bankFor } from "../store/hindsight.js";
import type { MemoryRecord, MemoryStore } from "../store/types.js";
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

/** Runs every prompt through recall twice: in the store's order and in activation order. Read-only. */
export async function runReplay({
	prompts,
	store,
	state,
	config,
	top,
	random,
	now,
	manifests = [],
	gate,
}: ReplayOptions): Promise<ReplayResult> {
	const warnings: string[] = [];
	const entries: ReplayEntry[] = [];
	// Sequential: the injected random stream is consumed in a fixed order.
	for (const prompt of prompts) {
		// The recorded directory may not exist here, so no scan: only what the transcript says.
		const cue = buildCue({
			cwd: prompt.cwd,
			manifests,
			...(prompt.activeSkill ? { activeSkill: prompt.activeSkill } : {}),
			recentTools: prompt.recentTools,
			organizations: config.organizations,
		});
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
		const byStore = await storeOrder(
			store,
			config,
			cue,
			prompt.text.trim() || cueText(cue),
			softTags(cue),
		);
		const query = prompt.text.trim() || cueText(cue);
		const gated = gate
			? await judgeGate(ranked, query, gate.judge, gate.threshold, (error) =>
					warnings.push(`judge: ${(error as Error).message}`),
				)
			: undefined;
		const dormant = (memory: MemoryRecord) => state.isDormant(memory.id);
		entries.push({
			number: entries.length + 1,
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
		});
	}
	return { run: runName(now), top, entries, warnings };
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
