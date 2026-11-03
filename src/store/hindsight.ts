import type {
	ListQuery,
	MemoryRecord,
	MemoryScore,
	MemoryStore,
	RecallQuery,
	RetainItem,
	TagCount,
} from "./types.js";

const genericBank = "generic";
const tagPageSize = 100;

/** The only place that names banks: `org-<organization>`, or `generic` without one. */
export function bankFor(organization: string | undefined): string {
	if (organization === undefined || organization === "" || organization === genericBank) {
		return genericBank;
	}
	return `org-${organization}`;
}

export class StoreError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "StoreError";
	}
}

export interface HindsightOptions {
	baseUrl: string;
	fetch?: typeof fetch;
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
	const record: MemoryRecord = {
		id: wire.id,
		text: wire.text,
		tags: wire.tags ?? [],
		createdAt: wire.created_at ?? wire.date ?? wire.mentioned_at ?? wire.occurred_start ?? "",
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
	private readonly fetchImpl: typeof fetch;

	constructor(options: HindsightOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetch ?? fetch;
	}

	private url(bank: string, path: string, params?: URLSearchParams): string {
		const query = params && [...params].length > 0 ? `?${params}` : "";
		return `${this.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}${path}${query}`;
	}

	private async request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T | null> {
		const init: RequestInit = { method };
		if (body !== undefined) {
			init.headers = { "content-type": "application/json" };
			init.body = JSON.stringify(body);
		}
		const response = await this.fetchImpl(url, init);
		if (response.status === 404 && method === "GET") return null;
		if (!response.ok) {
			throw new StoreError(
				`${method} ${url} failed: ${response.status} ${await response.text()}`,
				response.status,
			);
		}
		return (await response.json()) as T;
	}

	async retain(bank: string, items: RetainItem[]): Promise<void> {
		const wireItems = items.map((item) => ({
			content: item.content,
			tags: item.tags,
			...(item.context !== undefined && { context: item.context }),
			...(item.metadata !== undefined && { metadata: item.metadata }),
			...(item.documentId !== undefined && { document_id: item.documentId }),
		}));
		await this.request("POST", this.url(bank, "/memories"), { items: wireItems, async: false });
	}

	async recall(bank: string, query: RecallQuery): Promise<MemoryRecord[]> {
		const body: Record<string, unknown> = { query: query.query };
		if (query.tags !== undefined) body.tags = query.tags;
		if (query.tagsMatch !== undefined) body.tags_match = query.tagsMatch;
		if (query.queryTimestamp !== undefined) body.query_timestamp = query.queryTimestamp;
		const response = await this.request<{ results: WireMemory[] }>(
			"POST",
			this.url(bank, "/memories/recall"),
			body,
		);
		return (response?.results ?? []).slice(0, query.topK).map(toRecord);
	}

	async get(bank: string, id: string): Promise<MemoryRecord | null> {
		const wire = await this.request<WireMemory>(
			"GET",
			this.url(bank, `/memories/${encodeURIComponent(id)}`),
		);
		return wire ? toRecord(wire) : null;
	}

	async list(bank: string, query: ListQuery): Promise<MemoryRecord[]> {
		const params = new URLSearchParams();
		for (const tag of query.tags ?? []) params.append("tags", tag);
		if (query.tagsMatch !== undefined) params.set("tags_match", query.tagsMatch);
		params.set("limit", String(query.limit));
		params.set("offset", String(query.offset));
		const response = await this.request<{ items: WireMemory[] }>(
			"GET",
			this.url(bank, "/memories/list", params),
		);
		return (response?.items ?? []).map(toRecord);
	}

	async listTags(bank: string): Promise<TagCount[]> {
		const tags: TagCount[] = [];
		for (let offset = 0; ; offset += tagPageSize) {
			const params = new URLSearchParams({ limit: String(tagPageSize), offset: String(offset) });
			const page = await this.request<{ items: TagCount[]; total: number }>(
				"GET",
				this.url(bank, "/tags", params),
			);
			const items = page?.items ?? [];
			for (const item of items) tags.push({ tag: item.tag, count: item.count });
			if (items.length === 0 || offset + items.length >= (page?.total ?? 0)) return tags;
		}
	}
}
