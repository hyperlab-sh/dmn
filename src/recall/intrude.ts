import { basename, dirname } from "node:path";
import { retrievalProbability } from "../activation/act-r.js";
import type { Config } from "../config/config.js";
import { type Cue, cueText } from "../cue/cue.js";
import type { LocalState } from "../state/state.js";
import type { MemoryStore } from "../store/types.js";
import { recall } from "./pipeline.js";
import type { RankedMemory } from "./rerank.js";

/** Candidates an intrusion considers; only the top one can surface. */
const intrusionTopK = 3;

const wordPattern = /[\p{L}\p{N}]+/gu;
const maximumCommandWords = 3;
const maximumWordLength = 24;
/** A command word that is a plain name: no flag, assignment, path or URL, so no place for a secret. */
const plainCommandWord = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Words of a path: its basename (extension dropped) and its parent directory's name. */
function pathWords(path: string): string[] {
	const name = basename(path).replace(/\.[^.]*$/, "");
	const parent = basename(dirname(path));
	return [...name.matchAll(wordPattern), ...parent.matchAll(wordPattern)].map(([word]) => word);
}

/** The first plain words of a command; stops at the first argument that is not one. */
function commandWords(command: string): string[] {
	const words: string[] = [];
	for (const word of command.trim().split(/\s+/)) {
		if (words.length === maximumCommandWords) break;
		if (!plainCommandWord.test(word) || word.length > maximumWordLength) break;
		words.push(word);
	}
	return words;
}

/**
 * The cue and recall query for the tool a call just used: a file's name and directory, or a
 * command's first words, merged with the session cue's phrase. Other tools add nothing.
 */
export function intrusionCue(
	cue: Cue,
	toolName: string,
	toolInput: unknown,
): { cue: Cue; query: string } {
	const input =
		typeof toolInput === "object" && toolInput !== null
			? (toolInput as Record<string, unknown>)
			: {};
	let words: string[] = [];
	let task = cue.task;
	if (toolName === "Bash" && typeof input.command === "string") {
		words = commandWords(input.command);
		if (/test/i.test(input.command)) task = "test";
	} else if (typeof input.file_path === "string" && input.file_path) {
		words = pathWords(input.file_path);
		if (toolName === "Read") task = "read";
		if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") task = "edit";
	}
	const next: Cue = { ...cue, task };
	return { cue: next, query: [...words, cueText(next)].join(" ") };
}

export interface IntrusionDecisionInput {
	/** Candidates ranked by activation, best first. */
	ranked: ReadonlyArray<RankedMemory>;
	config: Pick<Config, "intrusionThreshold" | "intrusionCooldown">;
	random: () => number;
	/** Tool calls since the last intrusion, not counting this one. */
	toolCallsSinceLast: number;
}

/** The top candidate when the cooldown is over and its retrieval probability wins the draw. */
export function decideIntrusion({
	ranked,
	config,
	random,
	toolCallsSinceLast,
}: IntrusionDecisionInput): RankedMemory | null {
	const [top] = ranked;
	if (!top || config.intrusionThreshold === null) return null;
	if (toolCallsSinceLast < config.intrusionCooldown) return null;
	return retrievalProbability(top.activation, config.intrusionThreshold) > random() ? top : null;
}

export interface IntrudeInput {
	store: MemoryStore;
	state: LocalState;
	config: Config;
	cue: Cue;
	sessionId: string;
	toolName: string;
	toolInput: unknown;
	onFanError?: (bank: string, error: unknown) => void;
	random?: () => number;
	now?: Date;
}

/**
 * Counts the tool call, and when the cooldown is over runs the prompt-time recall for the tool's
 * target and decides. An emission restarts the cooldown. It is not a use: only a citation counts.
 */
export async function intrude({
	store,
	state,
	config,
	cue,
	sessionId,
	toolName,
	toolInput,
	onFanError,
	random = Math.random,
	now = new Date(),
}: IntrudeInput): Promise<RankedMemory | null> {
	const toolCallsSinceLast = state.toolCallsSince(sessionId);
	state.bumpToolCalls(sessionId);
	if (config.intrusionThreshold === null || toolCallsSinceLast < config.intrusionCooldown) {
		return null;
	}
	const target = intrusionCue(cue, toolName, toolInput);
	const ranked = await recall({
		store,
		state,
		config: { ...config, topK: intrusionTopK },
		cue: target.cue,
		prompt: target.query,
		random,
		now,
		...(onFanError && { onFanError }),
	});
	const memory = decideIntrusion({ ranked, config, random, toolCallsSinceLast });
	if (memory) state.markIntrusion(sessionId);
	return memory;
}
