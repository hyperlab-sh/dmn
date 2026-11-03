import { type Cue, softTags } from "../cue/cue.js";
import {
	type Classification,
	JudgeError,
	type KindJudge,
	type MemoryKind,
} from "../judge/types.js";
import { bankFor } from "../store/hindsight.js";
import type { MemoryStore, RetainItem } from "../store/types.js";
import { shouldRetain, type Turn } from "./filter.js";

export type RetainResult = {
	retained: number;
	skipped: { role: Turn["role"]; reason: string }[];
};

export interface RetainTurnsOptions {
	now: Date;
	/**
	 * Classifies the retained texts into kinds; without one, or on any judge failure, every turn
	 * keeps `kind:turn`. Receives text only, and only what passed `shouldRetain`.
	 */
	judge?: KindJudge;
	/** A classification must reach this probability to leave `kind:turn`. Default 0.5. */
	kindThreshold?: number;
	/**
	 * Whole-call bound on `classify`: past it the kinds are dropped with one `onJudgeError` and
	 * every turn keeps `kind:turn`, whatever the judge does. Default: no bound.
	 */
	judgeDeadlineMs?: number;
	/** Receives a judge error; the retention itself still happens. */
	onJudgeError?: (error: unknown) => void;
	/**
	 * Waits out `judgeDeadlineMs`. The default is a timer a finished hook need not wait for;
	 * tests inject a promise they settle themselves.
	 */
	sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		// The losing deadline timer must not keep a hook process alive after the judge answered.
		timer.unref();
	});

/**
 * Retains the turns that pass `shouldRetain` into the cue's organization bank, tagged with the
 * cue's soft tags plus `kind:<kind>` — the judge's classification when one clears
 * `kindThreshold`, else `kind:turn`. The only caller of `store.retain` (secrets stop here,
 * before the judge sees anything).
 */
export async function retainTurns(
	store: MemoryStore,
	cue: Cue,
	turns: ReadonlyArray<Turn & { documentId?: string }>,
	{
		now,
		judge,
		kindThreshold = 0.5,
		judgeDeadlineMs,
		onJudgeError,
		sleep = defaultSleep,
	}: RetainTurnsOptions,
): Promise<RetainResult> {
	const retained: (Turn & { documentId?: string })[] = [];
	const skipped: RetainResult["skipped"] = [];
	for (const turn of turns) {
		const verdict = shouldRetain(turn);
		if (!verdict.retain) {
			skipped.push({ role: turn.role, reason: verdict.reason });
			continue;
		}
		retained.push(turn);
	}
	// Every kind starts at turn; only a classification that clears the bar replaces it.
	const kinds: MemoryKind[] = retained.map(() => "turn");
	if (judge && retained.length > 0) {
		try {
			const texts = retained.map((turn) => turn.text);
			// One call per event, with the retained texts only: the filter ran first.
			const call = judge.classify(texts);
			let classifications: Classification[];
			if (judgeDeadlineMs === undefined) {
				classifications = await call;
			} else {
				// Whichever leg loses the race may still settle later; that must not crash the hook.
				call.catch(() => {});
				const expired = sleep(judgeDeadlineMs).then((): Classification[] => {
					throw new JudgeError(`classify exceeded its ${judgeDeadlineMs}ms deadline`, 0);
				});
				expired.catch(() => {});
				classifications = await Promise.race([call, expired]);
			}
			for (const classification of classifications) {
				if (classification.probability < kindThreshold) continue;
				kinds[classification.index] = classification.kind;
			}
		} catch (error) {
			onJudgeError?.(error);
		}
	}
	const items: RetainItem[] = retained.map((turn, index) => ({
		content: turn.text,
		tags: [...softTags(cue), `kind:${kinds[index]}`],
		metadata: { speaker: turn.role, retained_at: now.toISOString() },
		// A repeated stop for the same turn replaces the document instead of duplicating it.
		...(turn.documentId !== undefined && { documentId: `${turn.documentId}:${turn.role}` }),
	}));
	// Fact extraction can take seconds; a hook must not wait for it.
	if (items.length > 0) await store.retain(bankFor(cue.organization), items, { async: true });
	return { retained: items.length, skipped };
}
