import type { JudgeMemory, MemoryKind } from "./types.js";

/**
 * The two usefulness questions, the one kind question and the state text they are asked over —
 * shared by `LayaJudge` and `TypeSafeJudge` so both providers ask byte-identical questions and
 * judge the same state: a judgement must not depend on which provider answered it.
 */

/** Memories are cut to this many characters before they enter a state. */
export const memoryLimit = 1500;

export const questions = {
	useful: {
		type: "noul",
		instructions: "Would the memory help the engineer do what the prompt asks?",
		// An object: the API rejects a string here with invalid_request.
		criteria: {
			true: "The memory tells the engineer something they need to do what the prompt asks",
			false: "The memory tells the engineer nothing they need to do what the prompt asks",
		},
	},
	level: {
		type: "score",
		instructions: "How much the memory helps the engineer do what the prompt asks.",
		criteria: [
			"useless: unrelated to the prompt",
			"background: about the same project or area, but not needed for this prompt",
			"helpful: contains something relevant the engineer can use for this prompt",
			"decisive: contains the fact or decision the engineer needs to do what the prompt asks",
		],
	},
};

export const kindQuestions = {
	kind: {
		type: "choice",
		instructions: "Which kind of memory is this text?",
		criteria: {
			turn: "an exchange that only makes sense inside its own session",
			learning:
				"a fact about the code, the tools or the environment that will hold in a later session",
			decision: "a choice that was made and the reason for it",
		},
	},
};

/** The kind question's criteria labels, as the `MemoryKind` contract spells them. */
export const kinds: readonly MemoryKind[] = ["turn", "learning", "decision"];

/** The state the usefulness questions are asked over: the prompt, then the memory. */
export const memoryState = (prompt: string, memory: JudgeMemory) =>
	`Prompt from the engineer:\n${prompt}\n\nMemory from a past session:\n${memory.text.slice(0, memoryLimit)}`;

/** Clamps a judged number into its contract range (`useful` 0..1, `level` 0..3). */
export const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, value));

/** Milliseconds a `Retry-After` header asks for: delay-seconds or an HTTP date. */
export function retryAfterMs(response: Response, now: number): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
