import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cue } from "../cue/cue.js";
import type { ReplayResult } from "./run.js";

export interface Judgement {
	prompt: number;
	id: string;
	order: "store" | "activation";
	useful: boolean | null;
}

export interface Scores {
	store: number;
	activation: number;
	judged: number;
	total: number;
	top: number;
}

export const summaryHeading = "## Summary";

const oneLine = (text: string, length: number) => text.replace(/\s+/g, " ").trim().slice(0, length);
const number = (value: number) => (Math.round(value * 1000) / 1000).toString();

function cueTuple(cue: Cue): string {
	const stack = cue.stack.length > 0 ? cue.stack.join(",") : "-";
	return `(${cue.organization}, ${cue.project}, ${stack}, ${cue.role}, ${cue.task})`;
}

/** The closing section: `unscored` until `score` runs, then both numbers side by side. */
export function renderSummary(scores?: Scores): string {
	if (!scores) return `${summaryHeading}\n\nunscored\n`;
	const p = `p@${scores.top}`;
	return [
		summaryHeading,
		"",
		`| order | ${p} |`,
		"|---|---|",
		`| store | ${scores.store.toFixed(2)} |`,
		`| activation | ${scores.activation.toFixed(2)} |`,
		"",
		`judged ${scores.judged}/${scores.total}`,
		"",
	].join("\n");
}

/** Writes `report.md` and the judgements skeleton (`useful: null`) into `directory`. */
export function writeReport(result: ReplayResult, directory: string): void {
	const lines = [`# dmn replay ${result.run}`, ""];
	const judgements: Judgement[] = [];
	for (const entry of result.entries) {
		lines.push(
			`### Prompt ${entry.number}`,
			"",
			`cue: ${cueTuple(entry.cue)}`,
			`> ${oneLine(entry.prompt.text, 120)}`,
			"",
			"store:",
		);
		entry.store.forEach((memory, rank) => {
			lines.push(
				`${rank + 1}. ${memory.id} score=${number(memory.score?.final ?? 0)} ${oneLine(memory.text, 80)}`,
			);
			judgements.push({ prompt: entry.number, id: memory.id, order: "store", useful: null });
		});
		lines.push("", "activation:");
		entry.activation.forEach((memory, rank) => {
			lines.push(
				`${rank + 1}. ${memory.id} A=${number(memory.activation)} (B=${number(memory.baseLevel)} S=${number(memory.spreading)} noise=${number(memory.noise)}) ${oneLine(memory.text, 80)}`,
			);
			judgements.push({ prompt: entry.number, id: memory.id, order: "activation", useful: null });
		});
		lines.push("");
	}
	lines.push(renderSummary());
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "report.md"), lines.join("\n"));
	writeFileSync(join(directory, "judgements.json"), `${JSON.stringify(judgements, null, 2)}\n`);
}
