import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Judge } from "../judge/types.js";
import type { Judgement } from "./report.js";
import { readJudgements } from "./score.js";

/** A run made before `replay judge` existed: the texts it needs were never written. */
export class MissingRunFileError extends Error {
	constructor(path: string) {
		super(`${path} not found; this run predates \`replay judge\`, make a new run`);
		this.name = "MissingRunFileError";
	}
}

function readTexts(path: string): Record<string, string> {
	if (!existsSync(path)) throw new MissingRunFileError(path);
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	const valid =
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.values(parsed).every((text) => typeof text === "string");
	if (!valid) throw new Error(`${path}: expected an object of strings`);
	return parsed as Record<string, string>;
}

/** The report with ` P(useful)=0.xx` right after the id of every shown memory that has one. */
export function annotateReport(report: string, judgements: Judgement[]): string {
	const probability = new Map<string, number>();
	for (const entry of judgements) {
		if (entry.judge)
			probability.set(`${entry.prompt}\0${entry.order}\0${entry.id}`, entry.judge.useful);
	}
	let prompt = 0;
	let order = "";
	return report
		.split("\n")
		.map((line) => {
			const heading = /^### Prompt (\d+)/.exec(line);
			if (heading) prompt = Number(heading[1]);
			if (line === "store:" || line === "activation:") order = line.slice(0, -1);
			const item = /^(\d+\. )(\S+)(?: P\(useful\)=\d\.\d\d)?(.*)$/.exec(line);
			if (!item) return line;
			const value = probability.get(`${prompt}\0${order}\0${item[2]}`);
			const shown = value === undefined ? "" : ` P(useful)=${value.toFixed(2)}`;
			return `${item[1]}${item[2]}${shown}${item[3]}`;
		})
		.join("\n");
}

/**
 * Fills `judgements.json` of a run from `judge`: each memory is judged once per prompt however
 * many orders show it. Entries the judge did not answer stay as they were.
 */
export async function judgeRun(
	directory: string,
	judge: Judge,
	threshold: number,
): Promise<{ judged: number; total: number }> {
	const judgements = readJudgements(join(directory, "judgements.json"));
	const memories = readTexts(join(directory, "memories.json"));
	const prompts = readTexts(join(directory, "prompts.json"));

	const ids = new Map<number, Set<string>>();
	for (const { prompt, id } of judgements) {
		if (memories[id] === undefined) continue;
		if (!ids.has(prompt)) ids.set(prompt, new Set());
		ids.get(prompt)?.add(id);
	}
	const answers = new Map<string, { useful: number; level: number }>();
	for (const [prompt, set] of ids) {
		const text = prompts[prompt];
		if (text === undefined) continue;
		const input = [...set].map((id) => ({ id, text: memories[id] as string }));
		for (const answer of await judge.judge(text, input)) {
			answers.set(`${prompt}\0${answer.id}`, { useful: answer.useful, level: answer.level });
		}
	}

	let judged = 0;
	for (const entry of judgements) {
		const answer = answers.get(`${entry.prompt}\0${entry.id}`);
		if (!answer) continue;
		entry.judge = answer;
		entry.useful = answer.useful >= threshold;
		judged += 1;
	}
	writeFileSync(join(directory, "judgements.json"), `${JSON.stringify(judgements, null, 2)}\n`);
	const reportPath = join(directory, "report.md");
	writeFileSync(reportPath, annotateReport(readFileSync(reportPath, "utf8"), judgements));
	return { judged, total: judgements.length };
}
