import type { Config } from "../config/config.js";
import { type Cue, cueText, softTags } from "../cue/cue.js";
import type { Judge, Judgement } from "../judge/types.js";
import { containsSecret } from "../retain/filter.js";
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
	/** With `judgeThreshold`: drops candidates the judge scores below it (one batch call). */
	judge?: Judge | undefined;
	judgeThreshold?: number | undefined;
	/** Called when the judge fails (the list stays unfiltered) or leaves candidates unanswered. */
	onJudgeError?: (error: unknown) => void;
	random?: () => number;
	now?: Date;
}

/** The query recall sends to the store and the judge: the prompt, or the cue's phrase without one. */
export function recallQuery(prompt: string | undefined, cue: Cue): string {
	return prompt?.trim() || cueText(cue);
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
	judge,
	judgeThreshold,
	onJudgeError,
	random = Math.random,
	now = new Date(),
}: RecallInput): Promise<RankedMemory[]> {
	const banks = [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	const query = {
		query: recallQuery(prompt, cue),
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
	const ranked = rerank(candidates, cue, fans, {
		state,
		parameters: config.activation,
		promptThreshold: config.promptThreshold,
		random,
		now,
	});
	if (!judge || judgeThreshold === undefined || ranked.length === 0) return ranked;
	return (await judgeGate(ranked, query.query, judge, judgeThreshold, onJudgeError)).kept;
}

/**
 * Keeps the candidates the judge rates at or above `threshold`, in order, and returns the judge's
 * answers by id. A candidate the judge did not answer is kept (a refused item is not evidence); a
 * judge that fails leaves the list unfiltered. Either way `onJudgeError` hears of it once. Text
 * holding a secret never leaves the machine: such a query skips the gate, such a memory goes
 * unjudged (and is kept).
 */
export async function judgeGate(
	ranked: RankedMemory[],
	query: string,
	judge: Judge,
	threshold: number,
	onJudgeError?: (error: unknown) => void,
): Promise<{ kept: RankedMemory[]; answers: Record<string, Judgement> }> {
	const answers: Record<string, Judgement> = {};
	if (containsSecret(query)) return { kept: ranked, answers };
	const sendable = ranked.filter((memory) => !containsSecret(memory.text));
	if (sendable.length === 0) return { kept: ranked, answers };
	try {
		for (const answer of await judge.judge(
			query,
			sendable.map(({ id, text }) => ({ id, text })),
		)) {
			answers[answer.id] = answer;
		}
	} catch (error) {
		onJudgeError?.(error);
		return { kept: ranked, answers };
	}
	const unanswered = sendable.filter((memory) => !answers[memory.id]).length;
	if (unanswered > 0) {
		onJudgeError?.(new Error(`the judge left ${unanswered} of ${sendable.length} unanswered`));
	}
	return {
		kept: ranked.filter(
			(memory) => (answers[memory.id]?.useful ?? Number.POSITIVE_INFINITY) >= threshold,
		),
		answers,
	};
}
