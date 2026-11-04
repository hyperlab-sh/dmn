import {
	clamp,
	kindQuestions,
	kinds,
	memoryLimit,
	memoryState,
	questions,
	retryAfterMs,
} from "./questions.js";
import {
	type Classification,
	type Judge,
	JudgeError,
	type JudgeMemory,
	type Judgement,
	type KindJudge,
	type MemoryKind,
} from "./types.js";

const typesafeBaseUrl = "https://api.typesafe.ai";
const typesafeModel = "jev-latest";
/** The endpoint has no batch form, so memory requests are pooled instead of batched. */
const inFlight = 8;
const maxAttempts = 5;
const baseDelayMs = 500;
const maxDelayMs = 60_000;

export interface TypeSafeOptions {
	apiKey: string;
	/** Default `https://api.typesafe.ai`; a local model server may answer the same API. */
	baseUrl?: string;
	/** Per-attempt limit. Default 30000. */
	timeoutMs?: number;
	/**
	 * Whole-call limit across every request, attempt, retry and wait, so a 429 storm cannot
	 * outlive the caller's budget; `timeoutMs` alone bounds one attempt. Default: no deadline.
	 */
	deadlineMs?: number;
	fetch?: typeof fetch;
	sleep?: (milliseconds: number) => Promise<void>;
	random?: () => number;
	/** Clock for `Retry-After` given as an HTTP date and for the deadline. */
	now?: () => number;
}

/**
 * The answers an item's request produced, or `undefined` when the service did not answer it.
 * A call where every item failed fails like a batch provider's would, with the first item's
 * error; a call where some stand resolves with those, the single-request form of a per-item
 * `{error}` entry.
 */
function settle<T>(answers: (T | undefined)[], errors: (JudgeError | undefined)[]): T[] {
	const answered = answers.filter((answer) => answer !== undefined) as T[];
	if (answered.length > 0 || errors.every((error) => error === undefined)) return answered;
	throw errors.find((error) => error !== undefined);
}

/**
 * Usefulness and kind judge over TypeSafe's Jev model (`/v1/systemone`, plain fetch). The
 * endpoint has no batch form — one request carries one state — so `judge` and `classify` send
 * one request per memory or text, at most `inFlight` of them in flight, with the state text
 * and the questions of `src/judge/questions.ts` (the ones `LayaJudge` sends).
 */
export class TypeSafeJudge implements Judge, KindJudge {
	private readonly apiKey: string;
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly deadlineMs: number | undefined;
	private readonly fetcher: typeof fetch;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly random: () => number;
	private readonly now: () => number;

	constructor({
		apiKey,
		baseUrl = typesafeBaseUrl,
		timeoutMs = 30_000,
		deadlineMs,
		fetch: fetcher = globalThis.fetch,
		sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		random = Math.random,
		now = () => Date.now(),
	}: TypeSafeOptions) {
		this.apiKey = apiKey;
		this.url = `${baseUrl.replace(/\/+$/, "")}/v1/systemone`;
		this.timeoutMs = timeoutMs;
		this.deadlineMs = deadlineMs;
		this.fetcher = fetcher;
		this.sleep = sleep;
		this.random = random;
		this.now = now;
	}

	async judge(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]> {
		const startedAt = this.now();
		return await this.askAll(memories, async (memory) => {
			const body = JSON.stringify({
				model: typesafeModel,
				state: memoryState(prompt, memory),
				questions,
			});
			return this.parseJudgement(await this.post(body, startedAt), memory);
		});
	}

	async classify(texts: string[]): Promise<Classification[]> {
		const startedAt = this.now();
		return await this.askAll(texts, async (text, index) => {
			const body = JSON.stringify({
				model: typesafeModel,
				// The state is the bare text: nothing but the text leaves the machine.
				state: text.slice(0, memoryLimit),
				questions: kindQuestions,
			});
			return this.parseClassification(await this.post(body, startedAt), index);
		});
	}

	/** One request per item, at most `inFlight` in flight; a failed request costs its item only. */
	private async askAll<Item, Answer>(
		items: Item[],
		ask: (item: Item, index: number) => Promise<Answer | undefined>,
	): Promise<Answer[]> {
		const answers: (Answer | undefined)[] = [];
		const errors: (JudgeError | undefined)[] = [];
		let next = 0;
		const worker = async () => {
			while (next < items.length) {
				const index = next++;
				try {
					answers[index] = await ask(items[index] as Item, index);
				} catch (error) {
					errors[index] = error as JudgeError;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(inFlight, items.length) }, worker));
		return settle(answers, errors);
	}

	/**
	 * One POST with the retries and timeout shared by both questions; returns the JSON payload.
	 * `startedAt` is the public call's start: the deadline bounds the whole call, not one item.
	 */
	private async post(body: string, startedAt: number): Promise<unknown> {
		// Milliseconds left of the whole-call budget; infinite without a deadline.
		const remaining = () =>
			this.deadlineMs === undefined
				? Number.POSITIVE_INFINITY
				: this.deadlineMs - (this.now() - startedAt);
		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetcher(this.url, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
					body,
					signal: AbortSignal.timeout(Math.max(0, Math.min(this.timeoutMs, remaining()))),
				});
			} catch (error) {
				throw new JudgeError(`POST ${this.url} failed: ${(error as Error).message}`, 0);
			}
			if (response.ok) {
				try {
					return await response.json();
				} catch {
					throw new JudgeError("response is not JSON", response.status);
				}
			}
			const retriable = response.status === 429 || response.status === 503;
			if (!retriable || attempt === maxAttempts) {
				throw new JudgeError(
					`POST ${this.url} failed: ${response.status} ${await response.text()}`,
					response.status,
				);
			}
			const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.5 + this.random() / 2);
			const wait = Math.min(maxDelayMs, Math.max(retryAfterMs(response, this.now()) ?? 0, backoff));
			// The budget is spent, or the wait alone would blow it: stop rather than hold the caller.
			if (wait >= remaining()) {
				throw new JudgeError(
					`POST ${this.url} abandoned: ${this.deadlineMs}ms deadline reached before attempt ${attempt + 1}`,
					0,
				);
			}
			await this.sleep(wait);
		}
	}

	/** `answers.useful.noul` and `answers.level.score`; anything else is unanswered. */
	private parseJudgement(payload: unknown, memory: JudgeMemory): Judgement | undefined {
		const answers = (
			payload as {
				answers?: { useful?: { noul?: unknown }; level?: { score?: unknown } };
			} | null
		)?.answers;
		const useful = answers?.useful?.noul;
		const level = answers?.level?.score;
		if (typeof useful !== "number" || typeof level !== "number") return undefined;
		return { id: memory.id, useful: clamp(useful, 0, 1), level: clamp(level, 0, 3) };
	}

	/** `answers.kind.choice` with the chosen label's probability; anything else is unanswered. */
	private parseClassification(payload: unknown, index: number): Classification | undefined {
		const kind = (payload as { answers?: { kind?: { choice?: unknown } } } | null)?.answers?.kind
			?.choice;
		if (!kinds.includes(kind as MemoryKind)) return undefined;
		const probability = (
			payload as { answers?: { kind?: { probabilities?: Record<string, unknown> } } } | null
		)?.answers?.kind?.probabilities?.[kind as string];
		if (typeof probability !== "number") return undefined;
		return { index, kind: kind as MemoryKind, probability: clamp(probability, 0, 1) };
	}
}
