import type {
	ListQuery,
	MemoryRecord,
	MemoryStore,
	RecallQuery,
	RetainItem,
	TagCount,
	TagsMatch,
} from "./types.js";

const wordPattern = /[\p{L}\p{N}]+/gu;

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(wordPattern) ?? []);
}

function matchesTags(memoryTags: string[], wanted: string[], mode: TagsMatch): boolean {
	const has = (tag: string) => memoryTags.includes(tag);
	const untagged = memoryTags.length === 0;
	switch (mode) {
		case "any":
			return wanted.length === 0 || untagged || wanted.some(has);
		case "all":
			return wanted.length === 0 || untagged || wanted.every(has);
		case "any_strict":
			return wanted.length === 0 || wanted.some(has);
		case "all_strict":
			return wanted.every(has);
		case "exact":
			return memoryTags.length === wanted.length && wanted.every(has);
	}
}

/**
 * In-process store with Hindsight's contract and deterministic scoring: keyword overlap with
 * the query, ties by insertion order. Also the store behind `DMN_STORE_URL=fake:`.
 */
export class FakeStore implements MemoryStore {
	private readonly banks = new Map<string, MemoryRecord[]>();
	private counter = 0;

	constructor(private readonly clock: () => Date = () => new Date()) {}

	private bank(name: string): MemoryRecord[] {
		let records = this.banks.get(name);
		if (!records) {
			records = [];
			this.banks.set(name, records);
		}
		return records;
	}

	async retain(bank: string, items: RetainItem[]): Promise<void> {
		const records = this.bank(bank);
		for (const item of items) {
			this.counter += 1;
			const record: MemoryRecord = {
				id: `mem-${this.counter}`,
				text: item.content,
				tags: [...item.tags],
				createdAt: this.clock().toISOString(),
			};
			if (item.context !== undefined) record.context = item.context;
			if (item.metadata !== undefined) record.metadata = { ...item.metadata };
			records.push(record);
		}
	}

	async recall(bank: string, query: RecallQuery): Promise<MemoryRecord[]> {
		const queryWords = words(query.query);
		const candidates = (this.banks.get(bank) ?? [])
			.filter((record) => matchesTags(record.tags, query.tags ?? [], query.tagsMatch ?? "any"))
			.map((record, order) => {
				const overlap = [...words(record.text)].filter((word) => queryWords.has(word)).length;
				return { record, order, overlap };
			});
		candidates.sort((a, b) => b.overlap - a.overlap || a.order - b.order);
		return candidates.slice(0, query.topK).map(({ record, overlap }) => ({
			...record,
			score: { final: overlap, keyword: overlap },
		}));
	}

	async get(bank: string, id: string): Promise<MemoryRecord | null> {
		return (this.banks.get(bank) ?? []).find((record) => record.id === id) ?? null;
	}

	async list(bank: string, query: ListQuery): Promise<MemoryRecord[]> {
		return (await this.listPage(bank, query)).items;
	}

	/** One page plus the filtered total, as Hindsight's list endpoint reports it. */
	async listPage(
		bank: string,
		query: ListQuery,
	): Promise<{ items: MemoryRecord[]; total: number }> {
		const filtered = (this.banks.get(bank) ?? []).filter((record) =>
			matchesTags(record.tags, query.tags ?? [], "any_strict"),
		);
		return {
			items: filtered.slice(query.offset, query.offset + query.limit),
			total: filtered.length,
		};
	}

	/** True once anything was retained into the bank. */
	hasBank(bank: string): boolean {
		return this.banks.has(bank);
	}

	async listTags(bank: string): Promise<TagCount[]> {
		const counts = new Map<string, number>();
		for (const record of this.banks.get(bank) ?? []) {
			for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		return [...counts].map(([tag, count]) => ({ tag, count }));
	}
}

interface RecallBody {
	query: string;
	tags?: string[] | null;
	tags_match?: TagsMatch;
	query_timestamp?: string;
}

interface RetainBody {
	items: {
		content: string;
		tags?: string[];
		context?: string;
		metadata?: Record<string, string>;
	}[];
}

function wire(record: MemoryRecord) {
	return {
		id: record.id,
		text: record.text,
		tags: record.tags,
		context: record.context ?? null,
		metadata: record.metadata ?? null,
		date: record.createdAt,
		scores: record.score ?? null,
	};
}

/** Serves the Hindsight endpoints dmn uses on a free localhost port, backed by a `FakeStore`. */
export function startFakeServer(): { url: string; stop: () => void } {
	const store = new FakeStore();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const match = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)(\/.*)$/);
			if (!match?.[1] || !match[2]) return new Response("not found", { status: 404 });
			const bank = decodeURIComponent(match[1]);
			const path = match[2];
			const tags = url.searchParams.getAll("tags");

			if (request.method === "POST" && path === "/memories") {
				const body = (await request.json()) as RetainBody;
				await store.retain(
					bank,
					body.items.map((item) => ({
						content: item.content,
						tags: item.tags ?? [],
						...(item.context !== undefined && { context: item.context }),
						...(item.metadata !== undefined && { metadata: item.metadata }),
					})),
				);
				return Response.json({
					success: true,
					bank_id: bank,
					items_count: body.items.length,
					async: false,
				});
			}
			if (request.method === "POST" && path === "/memories/recall") {
				const body = (await request.json()) as RecallBody;
				const results = await store.recall(bank, {
					query: body.query,
					topK: Number.MAX_SAFE_INTEGER,
					...(body.tags ? { tags: body.tags } : {}),
					...(body.tags_match ? { tagsMatch: body.tags_match } : {}),
				});
				return Response.json({ results: results.map(wire) });
			}
			if (request.method === "GET" && path === "/memories/list") {
				const limit = Number(url.searchParams.get("limit") ?? 100);
				const offset = Number(url.searchParams.get("offset") ?? 0);
				const page = await store.listPage(bank, {
					limit,
					offset,
					...(tags.length > 0 ? { tags } : {}),
				});
				return Response.json({ items: page.items.map(wire), total: page.total, limit, offset });
			}
			if (request.method === "GET" && path === "/tags") {
				if (!store.hasBank(bank))
					return Response.json({ detail: "bank not found" }, { status: 404 });
				const all = await store.listTags(bank);
				const limit = Number(url.searchParams.get("limit") ?? 100);
				const offset = Number(url.searchParams.get("offset") ?? 0);
				return Response.json({
					items: all.slice(offset, offset + limit),
					total: all.length,
					limit,
					offset,
				});
			}
			const single = path.match(/^\/memories\/([^/]+)$/);
			if (request.method === "GET" && single?.[1]) {
				const record = await store.get(bank, decodeURIComponent(single[1]));
				return record ? Response.json(wire(record)) : new Response("not found", { status: 404 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}
