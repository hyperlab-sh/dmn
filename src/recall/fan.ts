import type { LocalState } from "../state/state.js";
import type { MemoryStore, TagCount } from "../store/types.js";

/**
 * Memories per tag, summed over `banks`. Per-bank counts come from `state.tagFanCache` while
 * younger than `ttlSeconds`, otherwise from `store.listTags`. The TTL follows `state`'s clock,
 * so a caller that injects time must build `LocalState` with the same clock.
 * A bank whose `listTags` fails contributes nothing: fan counts only sharpen the ranking,
 * so a store hiccup must not cost the whole recall.
 */
export async function fanCounts(
	store: Pick<MemoryStore, "listTags">,
	state: LocalState,
	banks: ReadonlyArray<string>,
	ttlSeconds: number,
): Promise<Map<string, number>> {
	const perBank = await Promise.all(
		banks.map(async (bank): Promise<TagCount[]> => {
			const cached = state.tagFanCache.read(bank, ttlSeconds * 1000);
			if (cached) return cached;
			try {
				const fresh = await store.listTags(bank);
				state.tagFanCache.write(bank, fresh);
				return fresh;
			} catch {
				return [];
			}
		}),
	);
	const totals = new Map<string, number>();
	for (const counts of perBank) {
		for (const { tag, count } of counts) totals.set(tag, (totals.get(tag) ?? 0) + count);
	}
	return totals;
}
