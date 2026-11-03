import {
	type ActivationParameters,
	baseLevelActivation,
	type CueSource,
	defaultActivationParameters,
	defaultPromptThreshold,
	logisticNoise,
	spreadingActivation,
} from "../activation/act-r.js";
import { type Cue, softTags } from "../cue/cue.js";
import type { LocalState } from "../state/state.js";
import type { MemoryRecord } from "../store/types.js";
import { lifetimeHours } from "./age.js";

export type RankedMemory = MemoryRecord & {
	activation: number;
	baseLevel: number;
	spreading: number;
	noise: number;
	/** Added to `activation`: the pull of associated, highly activated memories. */
	association: number;
};

export interface RerankOptions {
	/** Local use counts and co-use associations. */
	state: Pick<LocalState, "uses" | "associations">;
	parameters?: Readonly<ActivationParameters>;
	random?: () => number;
	now?: Date;
	/** Only memories activated above it lend activation to their associates. */
	promptThreshold?: number;
}

/** Orders candidates by A = B + S + ε + association, highest first; ties keep the input order. */
export function rerank(
	candidates: ReadonlyArray<MemoryRecord>,
	cue: Cue,
	fanCounts: ReadonlyMap<string, number>,
	{
		state,
		parameters = defaultActivationParameters,
		random = Math.random,
		now = new Date(),
		promptThreshold = defaultPromptThreshold,
	}: RerankOptions,
): RankedMemory[] {
	const cueTags = new Set(softTags(cue));
	const scored = candidates.map((memory) => {
		const uses = state.uses(memory.id);
		// Unparseable dates count as brand new.
		const hours = lifetimeHours(memory.createdAt, uses.firstSeenAt, now) ?? 0;
		// Creation counts as the first use.
		const baseLevel = baseLevelActivation(uses.useCount + 1, hours, parameters.decay);
		const shared: CueSource[] = memory.tags
			.filter((tag) => cueTags.has(tag))
			.map((tag) => ({ fan: fanCounts.get(tag) ?? 1 }));
		const spreading = spreadingActivation(shared, parameters.maximumAssociativeStrength);
		const noise = logisticNoise(parameters.noiseScale, random);
		return { ...memory, baseLevel, spreading, noise, activation: baseLevel + spreading + noise };
	});
	// One pass from the pre-association activations, after all noise is drawn.
	// Per lender: the total edge weight and the strength of its fan, one query each.
	const lenders = new Map<string, { total: number; strength: number }>();
	if (parameters.associationWeight !== 0) {
		for (const memory of scored) {
			if (memory.activation <= promptThreshold) continue;
			const edges = state.associations(memory.id);
			lenders.set(memory.id, {
				total: edges.reduce((sum, edge) => sum + edge.weight, 0),
				strength: Math.max(0, parameters.maximumAssociativeStrength - Math.log(1 + edges.length)),
			});
		}
	}
	return scored
		.map((memory) => {
			let association = 0;
			if (parameters.associationWeight !== 0) {
				for (const { id, weight } of state.associations(memory.id)) {
					const lender = lenders.get(id);
					if (!lender) continue;
					association += parameters.associationWeight * (weight / lender.total) * lender.strength;
				}
			}
			return { ...memory, association, activation: memory.activation + association };
		})
		.sort((a, b) => b.activation - a.activation);
}
