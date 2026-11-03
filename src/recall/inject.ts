import type { RankedMemory } from "./rerank.js";

/** Rough token count: one token per four characters. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * One line per memory, in rank order, each marked `[m:<id>] ` so later turns can cite it.
 * Stops at the first memory that would overflow the budget, so rank order is never skipped.
 */
export function formatInjection(ranked: ReadonlyArray<RankedMemory>, budgetTokens: number): string {
	const lines: string[] = [];
	for (const memory of ranked) {
		const line = `[m:${memory.id}] ${memory.text.replace(/\s+/g, " ").trim()}`;
		if (estimateTokens([...lines, line].join("\n")) > budgetTokens) break;
		lines.push(line);
	}
	return lines.join("\n");
}
