import { isBankNotFound, StoreError } from "./errors.js";
import type {
	ConsolidationResult,
	ListQuery,
	MemoryRecord,
	MemoryScore,
	MemoryStore,
	RecallQuery,
	RetainItem,
	TagCount,
} from "./types.js";

// The error contract lives in ./errors.js; re-exported here for the package's public API.
export { isBankNotFound, StoreError } from "./errors.js";

const genericBank = "generic";
const tagPageSize = 100;

/** The only place that names banks: `org-<organization>`, or `generic` without one. */
export function bankFor(organization: string | undefined): string {
	if (organization === undefined || organization === "" || organization === genericBank) {
		return genericBank;
	}
	return `org-${organization}`;
}

/**
 * The tag form of an organization, should a memory ever carry one (`org:<name>`); the bank is
 * its only real home (D6), so nothing in dmn writes the tag today. A promotion copy entering
 * the `generic` bank drops it.
 */
export function isOrganizationTag(tag: string): boolean {
	return tag.startsWith("org:");
}

export interface HindsightOptions {
	baseUrl: string;
	/** Per-request limit, so a hung store cannot stall a hook. Default 2000. */
	timeoutMs?: number;
	/** Limit for retain, which waits on LLM fact extraction. Default 60000. */
	retainTimeoutMs?: number;
}

interface WireMemory {
	id: string;
	text: string;
	tags?: string[] | null;
	context?: string | null;
	metadata?: Record<string, string> | null;
	date?: string | null;
	created_at?: string | null;
	mentioned_at?: string | null;
	occurred_start?: string | null;
	scores?: (MemoryScore & Record<string, number | null | undefined>) | null;
}

function toRecord(wire: WireMemory): MemoryRecord {
	const createdAt = wire.created_at ?? wire.date ?? wire.mentioned_at ?? wire.occurred_start;
	if (!createdAt) throw new StoreError(`memory ${wire.id} has no timestamp`, 0);
	const record: MemoryRecord = {
		id: wire.id,
		text: wire.text,
		tags: wire.tags ?? [],
		createdAt,
	};
	if (wire.context) record.context = wire.context;
	if (wire.metadata) record.metadata = wire.metadata;
	if (wire.scores) {
		const score: MemoryScore = { final: wire.scores.final };
		for (const key of ["semantic", "keyword", "reranker"] as const) {
			const value = wire.scores[key];
			if (typeof value === "number") score[key] = value;
		}
		record.score = score;
	}
	return record;
}

/** Hindsight over its REST API with plain `fetch`; no SDK, no runtime dependency. */
export class HindsightStore implements MemoryStore {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly retainTimeoutMs: number;

	constructor({ baseUrl, timeoutMs = 2000, retainTimeoutMs = 60_000 }: HindsightOptions) {
		this.retainTimeoutMs = retainTimeoutMs;
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.timeoutMs = timeoutMs;
	}

	private url(bank: string, path: string, params?: URLSearchParams): string {
		const query = params && [...params].length > 0 ? `?${params}` : "";
		return `${this.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}${path}${query}`;
	}

	private async request<T>(
		method: "GET" | "POST",
		url: string,
		body?: unknown,
		timeoutMs: number = this.timeoutMs,
	): Promise<T> {
		const init: RequestInit = { method, signal: AbortSignal.timeout(timeoutMs) };
		if (body !== undefined) {
			init.headers = { "content-type": "application/json" };
			init.body = JSON.stringify(body);
		}
		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (error) {
			throw new StoreError(`${method} ${url} failed: ${(error as Error).message}`, 0);
		}
		if (!response.ok) {
			throw new StoreError(
				`${method} ${url} failed: ${response.status} ${await response.text()}`,
				response.status,
			);
		}
		return (await response.json()) as T;
	}

	async retain(
		bank: string,
		items: RetainItem[],
		options: { async?: boolean } = {},
	): Promise<void> {
		const wireItems = items.map((item) => ({
			content: item.content,
			tags: item.tags,
			...(item.context !== undefined && { context: item.context }),
			...(item.metadata !== undefined && { metadata: item.metadata }),
			...(item.documentId !== undefined && { document_id: item.documentId }),
		}));
		await this.request(
			"POST",
			this.url(bank, "/memories"),
			{ items: wireItems, async: options.async ?? false },
			this.retainTimeoutMs,
		);
	}

	/** The store's own maintenance: consolidation runs with or without `--apply`. */
	async consolidate(bank: string): Promise<ConsolidationResult> {
		const response = await this.request<{ operation_id?: string; deduplicated?: number }>(
			"POST",
			this.url(bank, "/consolidate"),
		);
		return { operationId: response.operation_id ?? "", deduplicated: response.deduplicated ?? 0 };
	}

	async recall(bank: string, query: RecallQuery): Promise<MemoryRecord[]> {
		const body: Record<string, unknown> = { query: query.query };
		if (query.tags !== undefined) body.tags = query.tags;
		if (query.tagsMatch !== undefined) body.tags_match = query.tagsMatch;
		if (query.queryTimestamp !== undefined) body.query_timestamp = query.queryTimestamp;
		try {
			const response = await this.request<{ results: WireMemory[] }>(
				"POST",
				this.url(bank, "/memories/recall"),
				body,
			);
			return response.results.slice(0, query.topK).map(toRecord);
		} catch (error) {
			if (isBankNotFound(error)) return [];
			throw error;
		}
	}

	async get(bank: string, id: string): Promise<MemoryRecord | null> {
		try {
			const wire = await this.request<WireMemory>(
				"GET",
				this.url(bank, `/memories/${encodeURIComponent(id)}`),
			);
			return toRecord(wire);
		} catch (error) {
			// 404: unknown id. 400: an id Hindsight cannot parse, so it cannot exist either.
			if (error instanceof StoreError && (error.status === 404 || error.status === 400)) {
				return null;
			}
			throw error;
		}
	}

	async list(bank: string, query: ListQuery): Promise<MemoryRecord[]> {
		const params = new URLSearchParams();
		for (const tag of query.tags ?? []) params.append("tags", tag);
		// Hindsight defaults to `any`, which also returns untagged memories; match the fake.
		params.set("tags_match", "any_strict");
		params.set("limit", String(query.limit));
		params.set("offset", String(query.offset));
		try {
			const response = await this.request<{ items: WireMemory[] }>(
				"GET",
				this.url(bank, "/memories/list", params),
			);
			return response.items.map(toRecord);
		} catch (error) {
			if (isBankNotFound(error)) return [];
			throw error;
		}
	}

	async listTags(bank: string): Promise<TagCount[]> {
		const tags: TagCount[] = [];
		for (let offset = 0; ; offset += tagPageSize) {
			const params = new URLSearchParams({ limit: String(tagPageSize), offset: String(offset) });
			let page: { items: TagCount[]; total: number };
			try {
				page = await this.request("GET", this.url(bank, "/tags", params));
			} catch (error) {
				// A bank nobody has written to yet has no tags; any other 404 is a wrong URL.
				if (isBankNotFound(error)) return [];
				throw error;
			}
			for (const item of page.items) tags.push({ tag: item.tag, count: item.count });
			if (page.items.length === 0 || offset + page.items.length >= page.total) return tags;
		}
	}
}
