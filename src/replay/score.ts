import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Judgement, renderSummary, type Scores, summaryHeading } from "./report.js";

export function readJudgements(path: string): Judgement[] {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	const valid =
		Array.isArray(parsed) &&
		parsed.every(
			(item) =>
				item &&
				typeof item.prompt === "number" &&
				typeof item.id === "string" &&
				(item.order === "store" || item.order === "activation") &&
				(item.useful === null || typeof item.useful === "boolean"),
		);
	if (!valid) throw new Error(`${path}: expected a list of {prompt, id, order, useful}`);
	return parsed as Judgement[];
}

/**
 * Precision@`top` per order: useful memories among each prompt's first `top` shown, over `top`,
 * averaged over the prompts. Unjudged (`null`) counts as not useful; `judged` counts the rest.
 */
export function score(
	judgements: Judgement[],
	top: number,
): { store: number; activation: number; judged: number } {
	const prompts = new Set(judgements.map((judgement) => judgement.prompt));
	const precision = (order: Judgement["order"]): number => {
		if (prompts.size === 0) return 0;
		let sum = 0;
		for (const prompt of prompts) {
			const shown = judgements
				.filter((judgement) => judgement.prompt === prompt && judgement.order === order)
				.slice(0, top);
			sum += shown.filter((judgement) => judgement.useful === true).length;
		}
		// Whole counts first: summing fractions would drift (0.1 + 0.2).
		return sum / (top * prompts.size);
	};
	return {
		store: precision("store"),
		activation: precision("activation"),
		judged: judgements.filter((judgement) => judgement.useful !== null).length,
	};
}

/** Rewrites the `## Summary` section of `<directory>/report.md` with the scores. */
export function writeSummary(directory: string, scores: Scores): void {
	const path = join(directory, "report.md");
	const report = readFileSync(path, "utf8");
	const start = report.lastIndexOf(`\n${summaryHeading}\n`);
	const head = start === -1 ? `${report.trimEnd()}\n\n` : report.slice(0, start + 1);
	writeFileSync(path, head + renderSummary(scores));
}
