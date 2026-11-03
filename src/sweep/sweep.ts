import { baseLevelActivation } from "../activation/act-r.js";
import type { Config } from "../config/config.js";
import { lifetimeHours } from "../recall/age.js";
import type { LocalState } from "../state/state.js";
import type { MemoryStore } from "../store/types.js";

export interface SweepInput {
	store: MemoryStore;
	state: LocalState;
	config: Config;
	banks: string[];
	now: Date;
	/** Report without marking anything dormant. */
	dryRun?: boolean;
	/** Memories fetched per store call. */
	pageSize?: number;
}

export interface SweepResult {
	/** Every memory listed, including those skipped for lack of an age. */
	examined: number;
	/** Below the floor, unprotected and not yet dormant; marked dormant unless this was a dry run. */
	dormant: string[];
	/** Below the floor but carrying a protected tag. */
	protectedKept: string[];
}

/**
 * Marks dormant the memories whose base-level activation is below `config.dormancyFloor` and that
 * carry no protected tag. Nothing is deleted and the store is never written: dormancy lives in the
 * local state and recall skips it. A revived memory is cleared once; if it is still below the
 * floor and unused, the next sweep marks it dormant again.
 */
export async function sweep({
	store,
	state,
	config,
	banks,
	now,
	dryRun = false,
	pageSize = 100,
}: SweepInput): Promise<SweepResult> {
	const result: SweepResult = { examined: 0, dormant: [], protectedKept: [] };
	const protectedTags = new Set(config.protectedTags);
	for (const bank of banks) {
		for (let offset = 0; ; offset += pageSize) {
			const page = await store.list(bank, { limit: pageSize, offset });
			for (const memory of page) {
				result.examined += 1;
				const uses = state.uses(memory.id);
				const hours = lifetimeHours(memory.createdAt, uses.firstSeenAt, now);
				if (hours === undefined) continue;
				// Creation counts as the first use, as in recall.
				const level = baseLevelActivation(uses.useCount + 1, hours, config.activation.decay);
				if (level >= config.dormancyFloor) continue;
				if (memory.tags.some((tag) => protectedTags.has(tag))) {
					result.protectedKept.push(memory.id);
					continue;
				}
				// Already dormant: examined, but this run writes nothing for it.
				if (state.isDormant(memory.id)) continue;
				result.dormant.push(memory.id);
				if (!dryRun) state.setDormant(memory.id);
			}
			if (page.length < pageSize) break;
		}
	}
	return result;
}
