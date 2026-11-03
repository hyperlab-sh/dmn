import { type Judge, JudgeError, type JudgeMemory, type Judgement } from "./types.js";

export const layaBaseUrl = "https://api.laya.studio";
const batchLimit = 64;
const memoryLimit = 1500;
const maxAttempts = 5;
const baseDelayMs = 500;
const maxDelayMs = 60_000;

export interface LayaOptions {
	apiKey: string;
	/** Default `https://api.laya.studio`; a local model server may answer the same API. */
	baseUrl?: string;
	/** Per-call limit. Default 5000. */
	timeoutMs?: number;
	fetch?: typeof fetch;
	sleep?: (milliseconds: number) => Promise<void>;
	random?: () => number;
}

const questions = {
	useful: {
		type: "noul",
		instructions: "The memory tells the engineer something they need to do what the prompt asks.",
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

const state = (prompt: string, memory: JudgeMemory) =>
	`Prompt from the engineer:\n${prompt}\n\nMemory from a past session:\n${memory.text.slice(0, memoryLimit)}`;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Seconds from a `Retry-After` header, if it is a number. */
function retryAfterMs(response: Response): number | undefined {
	const seconds = Number(response.headers.get("retry-after"));
	return response.headers.get("retry-after") && Number.isFinite(seconds) && seconds >= 0
		? seconds * 1000
		: undefined;
}

/** Usefulness judge over Laya's `/v1/systemone/batch`, plain fetch. Sends prompt and memory text only. */
export class LayaJudge implements Judge {
	private readonly apiKey: string;
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly fetcher: typeof fetch;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly random: () => number;

	constructor({
		apiKey,
		baseUrl = layaBaseUrl,
		timeoutMs = 5000,
		fetch: fetcher = globalThis.fetch,
		sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		random = Math.random,
	}: LayaOptions) {
		this.apiKey = apiKey;
		this.url = `${baseUrl.replace(/\/+$/, "")}/v1/systemone/batch`;
		this.timeoutMs = timeoutMs;
		this.fetcher = fetcher;
		this.sleep = sleep;
		this.random = random;
	}

	async judge(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]> {
		const judgements: Judgement[] = [];
		for (let start = 0; start < memories.length; start += batchLimit) {
			judgements.push(...(await this.batch(prompt, memories.slice(start, start + batchLimit))));
		}
		return judgements;
	}

	private async batch(prompt: string, memories: JudgeMemory[]): Promise<Judgement[]> {
		const body = JSON.stringify({
			requests: memories.map((memory) => ({ state: state(prompt, memory), questions })),
		});
		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetcher(this.url, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
					body,
					signal: AbortSignal.timeout(this.timeoutMs),
				});
			} catch (error) {
				throw new JudgeError(`POST ${this.url} failed: ${(error as Error).message}`, 0);
			}
			if (response.ok) return this.parse(await response.json(), memories);
			const retriable = response.status === 429 || response.status === 503;
			if (!retriable || attempt === maxAttempts) {
				throw new JudgeError(
					`POST ${this.url} failed: ${response.status} ${await response.text()}`,
					response.status,
				);
			}
			const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.5 + this.random() / 2);
			await this.sleep(Math.min(maxDelayMs, Math.max(retryAfterMs(response) ?? 0, backoff)));
		}
	}

	private parse(payload: unknown, memories: JudgeMemory[]): Judgement[] {
		const results = (payload as { results?: unknown } | null)?.results;
		if (!Array.isArray(results) || results.length !== memories.length) {
			throw new JudgeError("response has no results matching the requests", 0);
		}
		return memories.map((memory, index) => {
			const answers = (
				results[index] as {
					answers?: { useful?: { noul?: unknown }; level?: { score?: unknown } };
				} | null
			)?.answers;
			const useful = answers?.useful?.noul;
			const level = answers?.level?.score;
			if (typeof useful !== "number" || typeof level !== "number") {
				throw new JudgeError(`result ${index} has no useful/level answers`, 0);
			}
			return { id: memory.id, useful: clamp(useful, 0, 1), level: clamp(level, 0, 3) };
		});
	}
}
