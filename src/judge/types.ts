export interface JudgeMemory {
	id: string;
	text: string;
}

export interface Judgement {
	id: string;
	/** Calibrated P(the memory helps with the prompt), in [0, 1]. */
	useful: number;
	/** Expected usefulness level, in [0, 3]: useless, background, helpful, decisive. */
	level: number;
}

/**
 * Store-agnostic usefulness judge: a `Judgement` per input memory it could answer, in input
 * order. An input the service refused (a per-item error) is absent from the result.
 */
export interface Judge {
	judge(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]>;
}

/** `status` is the HTTP status, or 0 when no response arrived or the body is unusable. */
export class JudgeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "JudgeError";
	}
}
