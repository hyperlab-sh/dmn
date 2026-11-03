/**
 * ACT-R activation (Anderson & Lebiere, "The Atomic Components of Thought").
 *
 * A memory's activation is the sum of three terms:
 *
 *   A = B + S + ε
 *
 * - B, base level: how much and how recently the memory has been used.
 * - S, spreading activation: how strongly the current context points at it.
 * - ε, noise: makes retrieval probabilistic, which is what lets a memory
 *   surface unprompted (an "intrusive thought") without surfacing every time.
 *
 * Parameter defaults are the ones used by memory-v2 (MIT), which match the
 * ACT-R literature: decay 0.5, maximum associative strength 1.6, retrieval
 * threshold -0.5, noise scale 0.25.
 */

export interface ActivationParameters {
	/** Base-level decay rate d. 0.5 in the literature. */
	decay: number;
	/** S_max: the associative strength of a cue linked to exactly one memory. */
	maximumAssociativeStrength: number;
	/** τ: the activation at which retrieval probability is 0.5. */
	retrievalThreshold: number;
	/** s: scale of the logistic noise added to activation. */
	noiseScale: number;
	/** Scale of the co-use association term added to activation. 0 turns it off. */
	associationWeight: number;
}

export const defaultActivationParameters: Readonly<ActivationParameters> = {
	decay: 0.5,
	maximumAssociativeStrength: 1.6,
	retrievalThreshold: -0.5,
	noiseScale: 0.25,
	associationWeight: 0.5,
};

/**
 * Base-level activation using the optimized-learning approximation:
 *
 *   B = ln(n / (1 - d)) - d · ln(L)
 *
 * `useCount` counts the memory's creation as its first use, so it is at least 1.
 * `lifetimeHours` is the time since creation; it is clamped to one minute so a
 * brand-new memory does not get infinite activation.
 */
export function baseLevelActivation(
	useCount: number,
	lifetimeHours: number,
	decay: number = defaultActivationParameters.decay,
): number {
	const uses = Math.max(1, useCount);
	const lifetime = Math.max(1 / 60, lifetimeHours);
	return Math.log(uses / (1 - decay)) - decay * Math.log(lifetime);
}

/**
 * A cue the current context shares with the memory being scored. `fan` is the
 * number of memories that cue is linked to. A cue linked to everything
 * (`org:acme`) has a high fan and spreads almost nothing; a specific cue
 * (`stack:marko`) spreads a lot. This is the fan effect, and it is what keeps
 * a broad context from lighting up every memory it contains.
 */
export interface CueSource {
	fan: number;
	/** Attentional weight W. Defaults to 1 / number of cues. */
	weight?: number;
}

/**
 * Spreading activation from the cues the context shares with the memory:
 *
 *   S = Σ_j W_j · max(0, S_max - ln(fan_j))
 *
 * Only pass the cues the memory actually shares with the context; a cue the
 * memory is not linked to contributes nothing by definition.
 */
export function spreadingActivation(
	sharedCues: ReadonlyArray<CueSource>,
	maximumAssociativeStrength: number = defaultActivationParameters.maximumAssociativeStrength,
): number {
	if (sharedCues.length === 0) return 0;
	const defaultWeight = 1 / sharedCues.length;
	let total = 0;
	for (const cue of sharedCues) {
		const fan = Math.max(1, cue.fan);
		const strength = Math.max(0, maximumAssociativeStrength - Math.log(fan));
		total += (cue.weight ?? defaultWeight) * strength;
	}
	return total;
}

/**
 * A sample from the logistic distribution with scale `s`, as ACT-R uses for
 * activation noise. `random` must return a number in [0, 1); inject a
 * deterministic one in tests. Returns 0 for random() = 0.5.
 */
export function logisticNoise(
	noiseScale: number = defaultActivationParameters.noiseScale,
	random: () => number = Math.random,
): number {
	const uniform = Math.min(Math.max(random(), Number.EPSILON), 1 - Number.EPSILON);
	return noiseScale * Math.log(uniform / (1 - uniform));
}

export interface ActivationInput {
	/** Times the memory was used, counting its creation. */
	useCount: number;
	/** Hours since the memory was created. */
	lifetimeHours: number;
	/** Cues shared between the current context and this memory. */
	sharedCues: ReadonlyArray<CueSource>;
}

/** Total activation A = B + S + ε. */
export function activation(
	input: ActivationInput,
	parameters: Readonly<ActivationParameters> = defaultActivationParameters,
	random: () => number = Math.random,
): number {
	return (
		baseLevelActivation(input.useCount, input.lifetimeHours, parameters.decay) +
		spreadingActivation(input.sharedCues, parameters.maximumAssociativeStrength) +
		logisticNoise(parameters.noiseScale, random)
	);
}

/**
 * Probability that a memory with activation A is retrieved:
 *
 *   P = 1 / (1 + e^(-(A - τ) / s))
 *
 * 0.5 at the threshold, rising with activation. The intrusive-thought path
 * samples against this with a higher threshold than prompt-time recall.
 */
export function retrievalProbability(
	activationValue: number,
	retrievalThreshold: number = defaultActivationParameters.retrievalThreshold,
	noiseScale: number = defaultActivationParameters.noiseScale,
): number {
	return 1 / (1 + Math.exp(-(activationValue - retrievalThreshold) / noiseScale));
}
