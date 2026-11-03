import { expect, test } from "bun:test";
import { estimateTokens, formatInjection } from "./inject.js";
import type { RankedMemory } from "./rerank.js";

const ranked = (id: string, text: string): RankedMemory => ({
	id,
	text,
	tags: [],
	createdAt: "2026-01-01T00:00:00Z",
	activation: 0,
	baseLevel: 0,
	spreading: 0,
	noise: 0,
});

const memories = [
	ranked("a", "first   memory\nacross lines"),
	ranked("b", "second memory"),
	ranked("c", "third memory that no longer fits"),
];

test("estimateTokens is ceil(chars / 4)", () => {
	expect(estimateTokens("")).toBe(0);
	expect(estimateTokens("abcd")).toBe(1);
	expect(estimateTokens("abcde")).toBe(2);
});

test("fits exactly two of three: rank order, id markers, one trimmed line each", () => {
	const two = "[m:a] first memory across lines\n[m:b] second memory";
	const output = formatInjection(memories, estimateTokens(two));
	expect(output).toBe(two);
	expect(formatInjection(memories, estimateTokens(two) - 1)).toBe(
		"[m:a] first memory across lines",
	);
});

test("an empty list, or a budget too small for one entry, gives an empty string", () => {
	expect(formatInjection([], 100)).toBe("");
	expect(formatInjection(memories, 1)).toBe("");
});
