import type { Config } from "../config/config.js";
import { type Cue, cueText, softTags } from "../cue/cue.js";
import type { LocalState } from "../state/state.js";
import { bankFor } from "../store/hindsight.js";
import type { MemoryRecord, MemoryStore } from "../store/types.js";
import { fanCounts } from "./fan.js";
import { type RankedMemory, rerank } from "./rerank.js";

export interface RecallInput {
	store: MemoryStore;
	state: LocalState;
	config: Config;
	cue: Cue;
	/** The user's prompt; the cue's phrase stands in when there is none. */
	prompt?: string | undefined;
	/** Called when a bank's tag counts cannot be fetched; recall carries on without them. */
	onFanError?: (bank: string, error: unknown) => void;
	random?: () => number;
	now?: Date;
}

/**
 * Async because the store is: callers must await it.
 * Candidates from the cue's organization bank and `generic`, minus dormant, ranked by activation. */
export async function recall({
	store,
	state,
	config,
	cue,
	prompt,
	onFanError,
	random = Math.random,
	now = new Date(),
}: RecallInput): Promise<RankedMemory[]> {
	const banks = [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	const query = {
		query: prompt?.trim() || cueText(cue),
		tags: softTags(cue),
		tagsMatch: "any" as const,
		topK: config.topK,
	};
	const [perBank, fans] = await Promise.all([
		Promise.all(banks.map((bank) => store.recall(bank, query))),
		fanCounts(store, state, banks, config.fanCacheSeconds, onFanError),
	]);
	const seen = new Set<string>();
	const candidates: MemoryRecord[] = [];
	for (const memory of perBank.flat()) {
		if (seen.has(memory.id) || state.isDormant(memory.id)) continue;
		seen.add(memory.id);
		candidates.push(memory);
	}
	return rerank(candidates, cue, fans, {
		state,
		parameters: config.activation,
		promptThreshold: config.promptThreshold,
		random,
		now,
	});
}
