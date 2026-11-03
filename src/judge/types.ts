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

/** Store-agnostic usefulness judge: one `Judgement` per input memory, in input order. */
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
