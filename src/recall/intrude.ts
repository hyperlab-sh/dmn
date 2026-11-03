import { basename, dirname } from "node:path";
import { retrievalProbability } from "../activation/act-r.js";
import type { Config } from "../config/config.js";
import { type Cue, cueText } from "../cue/cue.js";
import type { Judge } from "../judge/types.js";
import { containsSecret } from "../retain/filter.js";
import type { LocalState } from "../state/state.js";
import type { MemoryStore } from "../store/types.js";
import { recall } from "./pipeline.js";
import type { RankedMemory } from "./rerank.js";

/** Candidates an intrusion considers; only the top one can surface. */
const intrusionTopK = 3;

const wordPattern = /[\p{L}\p{N}]+/gu;
const maximumNameLength = 24;
const maximumSubcommandLength = 12;
/** A command's name is plain: no flag, assignment, path or URL. */
const commandName = /^[A-Za-z][A-Za-z0-9_.-]*$/;
/** A subcommand is letters only: a token or a password has digits or dashes more often than not. */
const subcommand = /^[a-z]+$/;

/** Words of a path: its basename (extension dropped) and its parent directory's name. */
function pathWords(path: string): string[] {
	const name = basename(path).replace(/\.[^.]*$/, "");
	const parent = basename(dirname(path));
	return [...name.matchAll(wordPattern), ...parent.matchAll(wordPattern)].map(([word]) => word);
}

/** The command name and at most one lowercase subcommand: no argument that could be a secret. */
function commandWords(command: string): string[] {
	const [name, next] = command.trim().split(/\s+/);
	if (!name || !commandName.test(name) || name.length > maximumNameLength) return [];
	if (next && subcommand.test(next) && next.length <= maximumSubcommandLength) return [name, next];
	return [name];
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
	config: IntrusionRule;
	/** The decision draw. */
	random: () => number;
	/** Tool calls since the last intrusion, not counting this one. */
	toolCallsSinceLast: number;
}

type IntrusionRule = Pick<Config, "intrusionThreshold" | "intrusionCooldown">;

/** Whether a call may surface a thought at all: the path is on and the cooldown is over. */
export function isEligible(config: IntrusionRule, toolCallsSinceLast: number): boolean {
	return config.intrusionThreshold !== null && toolCallsSinceLast >= config.intrusionCooldown;
}

/** The top candidate when the call is eligible and its retrieval probability wins the draw. */
export function decideIntrusion({
	ranked,
	config,
	random,
	toolCallsSinceLast,
}: IntrusionDecisionInput): RankedMemory | null {
	const [top] = ranked;
	if (!top || config.intrusionThreshold === null || !isEligible(config, toolCallsSinceLast)) {
		return null;
	}
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
	/**
	 * Judges the one memory the decision chose against `config.judge.intrusionThreshold`; nothing
	 * surfaces below it. A failing judge, or one that leaves the memory unanswered, is reported to
	 * `onJudgeError` and surfaces nothing.
	 */
	judge?: Judge | undefined;
	onJudgeError?: (error: unknown) => void;
	/** Activation noise of the recall. */
	random?: () => number;
	/** The decision draw; defaults to `random`. */
	draw?: () => number;
	now?: Date;
}

/**
 * Counts the tool call, and when the cooldown is over runs the prompt-time recall for the tool's
 * target and decides. The caller restarts the cooldown once it prints something. It is not a use:
 * only a citation counts.
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
	judge,
	onJudgeError,
	random = Math.random,
	draw = random,
	now = new Date(),
}: IntrudeInput): Promise<RankedMemory | null> {
	const toolCallsSinceLast = state.toolCallsSince(sessionId);
	state.bumpToolCalls(sessionId);
	if (!isEligible(config, toolCallsSinceLast)) return null;
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
	const chosen = decideIntrusion({ ranked, config, random: draw, toolCallsSinceLast });
	if (!chosen || !judge) return chosen;
	// An optional thought that cannot be judged is not shown. Text holding a secret never leaves
	// the machine, so it cannot be judged.
	if (containsSecret(target.query) || containsSecret(chosen.text)) return null;
	try {
		const [answer] = await judge.judge(target.query, [{ id: chosen.id, text: chosen.text }]);
		if (!answer) {
			onJudgeError?.(new Error("the judge left the chosen memory unanswered"));
			return null;
		}
		return answer.useful >= config.judge.intrusionThreshold ? chosen : null;
	} catch (error) {
		onJudgeError?.(error);
		return null;
	}
}
