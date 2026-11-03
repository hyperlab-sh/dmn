/** Small seeded generator (mulberry32) so noise is stable per seed and tests are exact. */
export function seededRandom(seed: string): () => number {
	let state = 2166136261;
	for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The decision draw of one tool call. Each call has its own, so a session's calls are not the
 * same draw replayed; the hook and its tests derive it the same way.
 */
export function intrusionDraw(seed: string, toolUseId: string): number {
	return seededRandom(`${seed}:${toolUseId}:intrusion`)();
}

/** The activation noise of one tool call's recall, independent of its decision draw. */
export function intrusionNoise(seed: string, toolUseId: string): () => number {
	return seededRandom(`${seed}:${toolUseId}:noise`);
}
