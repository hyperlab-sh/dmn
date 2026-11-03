import {
	type ActivationParameters,
	baseLevelActivation,
	type CueSource,
	defaultActivationParameters,
	logisticNoise,
	spreadingActivation,
} from "../activation/act-r.js";
import { type Cue, softTags } from "../cue/cue.js";
import type { MemoryUses } from "../state/state.js";
import type { MemoryRecord } from "../store/types.js";
import { lifetimeHours as ageInHours } from "./age.js";

export type RankedMemory = MemoryRecord & {
	activation: number;
	baseLevel: number;
	spreading: number;
	noise: number;
};

export interface RerankOptions {
	/** Local use counts; only `uses` is read. */
	state: { uses(memoryId: string): MemoryUses };
	parameters?: Readonly<ActivationParameters>;
	random?: () => number;
	now?: Date;
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
	}: RerankOptions,
): RankedMemory[] {
	const cueTags = new Set(softTags(cue));
	return candidates
		.map((memory) => {
			const uses = state.uses(memory.id);
			// Unparseable dates count as brand new.
			const lifetimeHours = ageInHours(memory.createdAt, uses.firstSeenAt, now) ?? 0;
			// Creation counts as the first use.
			const baseLevel = baseLevelActivation(uses.useCount + 1, lifetimeHours, parameters.decay);
			const shared: CueSource[] = memory.tags
				.filter((tag) => cueTags.has(tag))
				.map((tag) => ({ fan: fanCounts.get(tag) ?? 1 }));
			const spreading = spreadingActivation(shared, parameters.maximumAssociativeStrength);
			const noise = logisticNoise(parameters.noiseScale, random);
			return { ...memory, baseLevel, spreading, noise, activation: baseLevel + spreading + noise };
		})
		.sort((a, b) => b.activation - a.activation);
}
