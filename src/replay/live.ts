import { basename } from "node:path";
import type { Cue } from "../cue/cue.js";
import type { Judge } from "../judge/types.js";
import { judgeGate } from "../recall/pipeline.js";
import type { RankedMemory } from "../recall/rerank.js";
import { retainTurns } from "../retain/retain.js";
import { recordUses } from "../retain/uses.js";
import type { LocalState } from "../state/state.js";
import type { MemoryStore } from "../store/types.js";
import { answersFrom, promptsFrom, type ReplayPrompt } from "./transcript.js";

/** A prompt of the live walk: the prompt itself, the answer that follows it, and its file. */
export interface LivePrompt extends ReplayPrompt {
	/** The assistant text that follows the prompt in its transcript. */
	answer: string;
	/** The transcript's basename; the documentId namespace of the retained turns. */
	file: string;
}

/** A prompt the live walk cannot place in time: no timestamp, or not a parseable date. */
export class UntimedPromptError extends Error {
	constructor(
		readonly file: string,
		readonly index: number,
	) {
		super(`${file}: prompt ${index} has no timestamp; the live walk needs one`);
		this.name = "UntimedPromptError";
	}
}

/**
 * The prompts of every transcript, merged and walked in timestamp order: recall at prompt N
 * then sees only what a live install would have retained before N. Ties keep the per-file
 * order. A prompt without a usable timestamp is an error, thrown before anything is retained.
 */
export function orderPrompts(transcripts: string[]): LivePrompt[] {
	const ordered: LivePrompt[] = [];
	for (const path of transcripts) {
		const file = basename(path);
		const answers = answersFrom(path);
		const prompts = promptsFrom(path);
		for (const prompt of prompts) {
			// An unparseable `at` is as useless as none: every step of the walk keys on it.
			if (!prompt.at || Number.isNaN(Date.parse(prompt.at))) {
				throw new UntimedPromptError(file, prompt.index);
			}
			ordered.push({ ...prompt, file, answer: answers[prompt.index] ?? "" });
		}
	}
	return ordered.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Retains one prompt's user and assistant turns with the prompt's own time — the call the Stop
 * hook would have made then. `documentId` `<basename>:<index>` namespaces the pair, so a
 * replayed retain replaces its document instead of duplicating it.
 */
export function retainPrompt(
	store: MemoryStore,
	cue: Cue,
	prompt: ReplayPrompt,
	answer: string,
	now: Date,
): Promise<{ retained: number; skipped: { role: "user" | "assistant"; reason: string }[] }> {
	const documentId = `${prompt.file ?? "transcript"}:${prompt.index}`;
	return retainTurns(
		store,
		cue,
		[
			{ role: "user", text: prompt.text, documentId },
			{ role: "assistant", text: answer, documentId },
		],
		{ now },
	);
}

/**
 * The judged use signal of the live walk (D36): every shown memory the judge calls useful at
 * `threshold` counts as used — `recordUse` under the prompt's project and `recordCoUse` over
 * the set — with the replayed clock, exactly as a cited marker would. Secrets never reach the
 * judge and an unanswered memory is not evidence of use.
 */
export async function recordJudgedUses(
	state: LocalState,
	judge: Judge,
	threshold: number,
	query: string,
	shown: RankedMemory[],
	project: string,
	turnId: string,
	onJudgeError?: (error: unknown) => void,
): Promise<string[]> {
	const { answers } = await judgeGate(shown, query, judge, threshold, onJudgeError);
	const useful = shown.filter((memory) => (answers[memory.id]?.useful ?? -1) >= threshold);
	recordUses(
		state,
		useful.map((memory) => memory.id),
		turnId,
		project,
	);
	state.recordCoUse(
		useful.map((memory) => memory.id),
		turnId,
	);
	return useful.map((memory) => memory.id);
}
