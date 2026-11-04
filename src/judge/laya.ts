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

const layaBaseUrl = "https://api.laya.studio";
const batchLimit = 64;
const maxAttempts = 5;
const baseDelayMs = 500;
const maxDelayMs = 60_000;

export interface LayaOptions {
	apiKey: string;
	/** Default `https://api.laya.studio`; a local model server may answer the same API. */
	baseUrl?: string;
	/** Per-attempt limit. Default 30000: a 64-item batch of 512-token inputs is not a hook. */
	timeoutMs?: number;
	/**
	 * Whole-call limit across attempts, retries and waits, so a 429 storm cannot outlive the
	 * caller's budget; `timeoutMs` alone bounds one attempt. Default: no deadline.
	 */
	deadlineMs?: number;
	fetch?: typeof fetch;
	sleep?: (milliseconds: number) => Promise<void>;
	random?: () => number;
	/** Clock for `Retry-After` given as an HTTP date and for the deadline. */
	now?: () => number;
}

/**
 * Usefulness and kind judge over Laya's `/v1/systemone/batch`, plain fetch. Sends text only:
 * prompt and memory text to `judge`, the bare text to `classify`.
 */
export class LayaJudge implements Judge, KindJudge {
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
		baseUrl = layaBaseUrl,
		timeoutMs = 30_000,
		deadlineMs,
		fetch: fetcher = globalThis.fetch,
		sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		random = Math.random,
		now = () => Date.now(),
	}: LayaOptions) {
		this.apiKey = apiKey;
		this.url = `${baseUrl.replace(/\/+$/, "")}/v1/systemone/batch`;
		this.timeoutMs = timeoutMs;
		this.deadlineMs = deadlineMs;
		this.fetcher = fetcher;
		this.sleep = sleep;
		this.random = random;
		this.now = now;
	}

	async judge(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]> {
		const startedAt = this.now();
		const judgements: Judgement[] = [];
		for (let start = 0; start < memories.length; start += batchLimit) {
			judgements.push(
				...(await this.batch(prompt, memories.slice(start, start + batchLimit), startedAt)),
			);
		}
		return judgements;
	}

	async classify(texts: string[]): Promise<Classification[]> {
		const startedAt = this.now();
		const classifications: Classification[] = [];
		for (let start = 0; start < texts.length; start += batchLimit) {
			const slice = texts.slice(start, start + batchLimit);
			const body = JSON.stringify({
				requests: slice.map((text) => ({
					state: text.slice(0, memoryLimit),
					questions: kindQuestions,
				})),
			});
			classifications.push(...this.parseKinds(await this.post(body, startedAt), slice, start));
		}
		return classifications;
	}

	private async batch(
		prompt: string,
		memories: JudgeMemory[],
		startedAt: number,
	): Promise<Judgement[]> {
		const body = JSON.stringify({
			requests: memories.map((memory) => ({ state: memoryState(prompt, memory), questions })),
		});
		return this.parse(await this.post(body, startedAt), memories);
	}

	/**
	 * One POST with the retries and timeout shared by both questions; returns the JSON payload.
	 * `startedAt` is the public call's start: the deadline bounds the whole call, not one batch.
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

	private parse(payload: unknown, memories: JudgeMemory[]): Judgement[] {
		const results = (payload as { results?: unknown } | null)?.results;
		if (!Array.isArray(results) || results.length !== memories.length) {
			throw new JudgeError("response has no results matching the requests", 0);
		}
		const judgements: Judgement[] = [];
		memories.forEach((memory, index) => {
			const answers = (
				results[index] as {
					answers?: { useful?: { noul?: unknown }; level?: { score?: unknown } };
				} | null
			)?.answers;
			const useful = answers?.useful?.noul;
			const level = answers?.level?.score;
			// An item the service answered with {error} is left unanswered; the rest stand.
			if (typeof useful !== "number" || typeof level !== "number") return;
			judgements.push({ id: memory.id, useful: clamp(useful, 0, 1), level: clamp(level, 0, 3) });
		});
		return judgements;
	}

	/** `answers.kind.choice` with the chosen label's probability; anything else is unanswered. */
	private parseKinds(payload: unknown, texts: string[], offset: number): Classification[] {
		const results = (payload as { results?: unknown } | null)?.results;
		if (!Array.isArray(results) || results.length !== texts.length) {
			throw new JudgeError("response has no results matching the requests", 0);
		}
		const classifications: Classification[] = [];
		texts.forEach((_, index) => {
			const kind = (results[index] as { answers?: { kind?: { choice?: unknown } } } | null)?.answers
				?.kind?.choice;
			if (!kinds.includes(kind as MemoryKind)) return;
			const probabilities = (
				results[index] as {
					answers?: { kind?: { probabilities?: Record<string, unknown> } };
				} | null
			)?.answers?.kind?.probabilities;
			const probability = probabilities?.[kind as string];
			if (typeof probability !== "number") return;
			classifications.push({
				index: offset + index,
				kind: kind as MemoryKind,
				probability: clamp(probability, 0, 1),
			});
		});
		return classifications;
	}
}
