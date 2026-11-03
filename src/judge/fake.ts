import type { Judge, JudgeMemory, Judgement } from "./types.js";

const words = (text: string): Set<string> =>
	new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** Offline judge: the share of the smaller text's words found in the other is the probability. */
export class FakeJudge implements Judge {
	/** Calls to `judge`. */
	calls = 0;
	/** Memories judged over all calls. */
	judged = 0;

	async judge(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]> {
		this.calls += 1;
		this.judged += memories.length;
		const promptWords = words(prompt);
		return memories.map((memory) => {
			const memoryWords = words(memory.text);
			const smaller = Math.min(promptWords.size, memoryWords.size);
			let shared = 0;
			for (const word of memoryWords) if (promptWords.has(word)) shared += 1;
			const useful = smaller === 0 ? 0 : shared / smaller;
			return { id: memory.id, useful, level: useful * 3 };
		});
	}
}
