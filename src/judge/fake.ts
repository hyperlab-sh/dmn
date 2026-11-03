import type {
	Classification,
	Judge,
	JudgeMemory,
	Judgement,
	KindJudge,
	MemoryKind,
} from "./types.js";

const words = (text: string): Set<string> =>
	new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** What `classify` answers for a text: the kind and, optionally, its probability (else 1). */
export interface FakeKind {
	kind: MemoryKind;
	probability?: number;
}

interface FakeJudgeOptions {
	/** Ids the judge leaves unanswered, like an item the service refused. */
	skip?: Iterable<string>;
	/** Fixed probability per id, in place of the word overlap. */
	probabilities?: Record<string, number>;
	/** Makes every call throw this, like an unreachable service. */
	failWith?: Error;
	/** Per-text kind table for `classify`; a text not in it is `turn`. */
	kinds?: Record<string, FakeKind>;
	/** Texts `classify` leaves unanswered, like items the service refused. */
	skipTexts?: Iterable<string>;
}

/** Offline judge: the share of the smaller text's words found in the other is the probability. */
export class FakeJudge implements Judge, KindJudge {
	private readonly skip: Set<string>;
	private readonly probabilities: Record<string, number>;
	private readonly failWith: Error | undefined;
	private readonly kinds: Record<string, FakeKind>;
	private readonly skipTexts: Set<string>;

	constructor(options: FakeJudgeOptions = {}) {
		this.skip = new Set(options.skip);
		this.probabilities = options.probabilities ?? {};
		this.failWith = options.failWith;
		this.kinds = options.kinds ?? {};
		this.skipTexts = new Set(options.skipTexts);
	}

	/** Calls to `judge`. */
	calls = 0;
	/** Memories judged over all calls. */
	judged = 0;
	/** Calls to `classify`. */
	classifyCalls = 0;
	/** Every text `classify` received, in order. */
	receivedTexts: string[] = [];

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

	async classify(texts: string[]): Promise<Classification[]> {
		this.classifyCalls += 1;
		this.receivedTexts.push(...texts);
		if (this.failWith) throw this.failWith;
		const classifications: Classification[] = [];
		texts.forEach((text, index) => {
			if (this.skipTexts.has(text)) return;
			const entry = this.kinds[text] ?? { kind: "turn" };
			classifications.push({ index, kind: entry.kind, probability: entry.probability ?? 1 });
		});
		return classifications;
	}
}
