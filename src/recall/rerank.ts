import {
	type ActivationParameters,
	baseLevelActivation,
	type CueSource,
	defaultActivationParameters,
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
	/** Local use counts; only `uses` is read. */
	state: Pick<LocalState, "uses" | "associations" | "associationFan">;
	parameters?: Readonly<ActivationParameters>;
	random?: () => number;
	now?: Date;
	/** Only memories activated above it lend activation to their associates. */
	promptThreshold?: number;
}

/** Orders candidates by A = B + S + ε, highest first; ties keep the input order. */
export function rerank(
	candidates: ReadonlyArray<MemoryRecord>,
	cue: Cue,
	fanCounts: ReadonlyMap<string, number>,
	{
		state,
		parameters = defaultActivationParameters,
		random = Math.random,
		now = new Date(),
		promptThreshold = -0.5,
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
	const lenders = new Map<string, number>();
	for (const memory of scored) {
		if (memory.activation > promptThreshold) lenders.set(memory.id, memory.activation);
	}
	return scored
		.map((memory) => {
			let association = 0;
			if (parameters.associationWeight !== 0) {
				for (const { id, weight } of state.associations(memory.id)) {
					if (!lenders.has(id)) continue;
					const total = state.associations(id).reduce((sum, edge) => sum + edge.weight, 0);
					const strength = Math.max(
						0,
						parameters.maximumAssociativeStrength - Math.log(1 + state.associationFan(id)),
					);
					association += parameters.associationWeight * (weight / total) * strength;
				}
			}
			return { ...memory, association, activation: memory.activation + association };
		})
		.sort((a, b) => b.activation - a.activation);
}
