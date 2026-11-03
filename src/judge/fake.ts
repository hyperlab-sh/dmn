import type { Judge, JudgeMemory, Judgement } from "./types.js";

const words = (text: string): Set<string> =>
	new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

export interface FakeJudgeOptions {
	/** Ids the judge leaves unanswered, like an item the service refused. */
	skip?: Iterable<string>;
	/** Fixed probability per id, in place of the word overlap. */
	probabilities?: Record<string, number>;
	/** Makes every call throw this, like an unreachable service. */
	failWith?: Error;
}

/** Offline judge: the share of the smaller text's words found in the other is the probability. */
export class FakeJudge implements Judge {
	private readonly skip: Set<string>;
	private readonly probabilities: Record<string, number>;
	private readonly failWith: Error | undefined;

	constructor(options: FakeJudgeOptions = {}) {
		this.skip = new Set(options.skip);
		this.probabilities = options.probabilities ?? {};
		this.failWith = options.failWith;
	}

	/** Calls to `judge`. */
	calls = 0;
	/** Memories judged over all calls. */
	judged = 0;

	async judge(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]> {
		this.calls += 1;
		this.judged += memories.length;
		if (this.failWith) throw this.failWith;
		const promptWords = words(prompt);
		return memories
			.filter((memory) => !this.skip.has(memory.id))
			.map((memory) => {
				const fixed = this.probabilities[memory.id];
				const memoryWords = words(memory.text);
				const smaller = Math.min(promptWords.size, memoryWords.size);
				let shared = 0;
				for (const word of memoryWords) if (promptWords.has(word)) shared += 1;
				const useful = fixed ?? (smaller === 0 ? 0 : shared / smaller);
				return { id: memory.id, useful, level: useful * 3 };
			});
	}
}
