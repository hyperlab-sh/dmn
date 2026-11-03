import { type Cue, softTags } from "../cue/cue.js";
import { bankFor } from "../store/hindsight.js";
import type { MemoryStore, RetainItem } from "../store/types.js";
import { shouldRetain, type Turn } from "./filter.js";

export type RetainResult = {
	retained: number;
	skipped: { role: Turn["role"]; reason: string }[];
};

/**
 * Retains the turns that pass `shouldRetain` into the cue's organization bank, tagged with the
 * cue's soft tags plus `kind:turn`. The only caller of `store.retain` (secrets stop here).
 */
export async function retainTurns(
	store: MemoryStore,
	cue: Cue,
	turns: ReadonlyArray<Turn & { documentId?: string }>,
	{ now }: { now: Date },
): Promise<RetainResult> {
	const items: RetainItem[] = [];
	const skipped: RetainResult["skipped"] = [];
	for (const turn of turns) {
		const verdict = shouldRetain(turn);
		if (!verdict.retain) {
			skipped.push({ role: turn.role, reason: verdict.reason });
			continue;
		}
		items.push({
			content: turn.text,
			tags: [...softTags(cue), "kind:turn"],
			metadata: { speaker: turn.role, retained_at: now.toISOString() },
			// A repeated stop for the same turn replaces the document instead of duplicating it.
			...(turn.documentId !== undefined && { documentId: `${turn.documentId}:${turn.role}` }),
		});
	}
	// Fact extraction can take seconds; a hook must not wait for it.
	if (items.length > 0) await store.retain(bankFor(cue.organization), items, { async: true });
	return { retained: items.length, skipped };
}
