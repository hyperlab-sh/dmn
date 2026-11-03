import type { LocalState } from "../state/state.js";
import type { MemoryStore, TagCount } from "../store/types.js";

/**
 * Memories per tag, summed over `banks`. Per-bank counts come from `state.tagFanCache` while
 * younger than `ttlSeconds` (judged by the state's own clock), otherwise from `store.listTags`.
 * `now` is accepted for call-site symmetry with `rerank`; the cache ages by the state clock.
 */
export async function fanCounts(
	store: MemoryStore,
	state: LocalState,
	banks: ReadonlyArray<string>,
	_now: Date,
	ttlSeconds: number,
): Promise<Map<string, number>> {
	const perBank = await Promise.all(
		banks.map(async (bank): Promise<TagCount[]> => {
			const cached = state.tagFanCache.read(bank, ttlSeconds * 1000);
			if (cached) return cached;
			const fresh = await store.listTags(bank);
			state.tagFanCache.write(bank, fresh);
			return fresh;
		}),
	);
	const totals = new Map<string, number>();
	for (const counts of perBank) {
		for (const { tag, count } of counts) totals.set(tag, (totals.get(tag) ?? 0) + count);
	}
	return totals;
}
