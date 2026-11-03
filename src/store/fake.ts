import { StoreError } from "./errors.js";
import type {
	ConsolidationResult,
	ListQuery,
	MemoryRecord,
	MemoryStore,
	MentalModel,
	MentalModelInput,
	RecallQuery,
	RetainItem,
	TagCount,
	TagsMatch,
} from "./types.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** One mental model as the fake holds it: the input plus what the store builds. */
interface StoredMentalModel extends MentalModelInput {
	content: string;
	refreshedAt: string;
}

/**
 * In-process store with Hindsight's contract and deterministic scoring: keyword overlap with
 * the query, ties by insertion order. Also the store behind `DMN_STORE_URL=fake:`.
 */
export class FakeStore implements MemoryStore {
	private readonly banks = new Map<string, MemoryRecord[]>();
	private readonly models = new Map<string, StoredMentalModel[]>();
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
				id: `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`,
				text: item.content,
				tags: [...item.tags],
				// The content time when the item carries one, else the clock (the ingest time).
				createdAt: item.timestamp ?? this.clock().toISOString(),
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
		query: ListQuery & { tagsMatch?: TagsMatch },
	): Promise<{ items: MemoryRecord[]; total: number }> {
		const filtered = (this.banks.get(bank) ?? []).filter((record) =>
			matchesTags(record.tags, query.tags ?? [], query.tagsMatch ?? "any_strict"),
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

	async consolidate(bank: string): Promise<ConsolidationResult> {
		if (!this.hasBank(bank)) {
			// The same error the adapter throws for the server's 404, so callers skip the bank.
			throw new StoreError(`POST consolidate failed: 404 Bank '${bank}' not found`, 404);
		}
		return { operationId: "fake", deduplicated: 0 };
	}

	async listTags(bank: string): Promise<TagCount[]> {
		const counts = new Map<string, number>();
		for (const record of this.banks.get(bank) ?? []) {
			for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		return [...counts].map(([tag, count]) => ({ tag, count }));
	}

	/** The model's content, deterministically: the first line of each of the role's memories. */
	private modelContent(bank: string, role: string): string {
		return (this.banks.get(bank) ?? [])
			.filter((record) => record.tags.includes(`role:${role}`))
			.map((record) => record.text.split("\n")[0])
			.join(" ");
	}

	async mentalModels(bank: string): Promise<MentalModel[]> {
		const models: MentalModel[] = [];
		for (const stored of this.models.get(bank) ?? []) {
			const role = stored.tags.find((tag) => tag.startsWith("role:"))?.slice("role:".length);
			// Mirrors the adapter, which lists nothing it cannot name a role for.
			if (role === undefined) continue;
			models.push({
				id: stored.id,
				role,
				content: stored.content,
				refreshedAt: stored.refreshedAt,
			});
		}
		return models;
	}

	async createMentalModel(bank: string, model: MentalModelInput): Promise<void> {
		const role = model.tags.find((tag) => tag.startsWith("role:"))?.slice("role:".length) ?? "";
		const stored: StoredMentalModel = {
			...model,
			content: this.modelContent(bank, role),
			refreshedAt: this.clock().toISOString(),
		};
		const models = this.models.get(bank) ?? [];
		// A repeated create replaces the model instead of duplicating it.
		const existing = models.findIndex((other) => other.id === model.id);
		if (existing === -1) models.push(stored);
		else models[existing] = stored;
		this.models.set(bank, models);
	}

	async refreshMentalModel(bank: string, id: string): Promise<void> {
		const stored = (this.models.get(bank) ?? []).find((model) => model.id === id);
		if (!stored) {
			throw new StoreError(`POST refresh failed: 404 Model '${id}' not found`, 404);
		}
		const role = stored.tags.find((tag) => tag.startsWith("role:"))?.slice("role:".length) ?? "";
		stored.content = this.modelContent(bank, role);
		stored.refreshedAt = this.clock().toISOString();
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
		document_id?: string;
		timestamp?: string;
	}[];
}

interface CreateMentalModelBody {
	id: string;
	name: string;
	source_query: string;
	tags?: string[];
	max_tokens?: number;
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

/**
 * Serves the Hindsight endpoints dmn uses on a free localhost port, backed by a `FakeStore`.
 * `options.judgeBatch`, when given, also answers the Laya judge API's
 * `POST /v1/systemone/batch`, so a hook test needs no second server; it returns the batch's
 * `results` array for the request items it receives.
 */
export function startFakeServer(options?: {
	judgeBatch?: (requests: { state: string; questions?: unknown }[]) => unknown[];
}): { url: string; stop: () => void } {
	const store = new FakeStore();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			let url: URL;
			try {
				url = new URL(request.url);
			} catch {
				return new Response("bad request", { status: 400 });
			}
			if (url.pathname === "/v1/systemone/batch") {
				if (!options?.judgeBatch) return new Response("not found", { status: 404 });
				const body = (await request.json()) as {
					requests: { state: string; questions?: unknown }[];
				};
				return Response.json({ results: options.judgeBatch(body.requests) });
			}
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
						...(item.document_id !== undefined && { documentId: item.document_id }),
						...(item.timestamp !== undefined && { timestamp: item.timestamp }),
					})),
				);
				return Response.json({
					success: true,
					bank_id: bank,
					items_count: body.items.length,
					async: false,
				});
			}
			const bankMissing = Response.json({ detail: `Bank '${bank}' not found` }, { status: 404 });
			if (request.method === "POST" && path === "/consolidate") {
				if (!store.hasBank(bank)) return bankMissing;
				return Response.json({ operation_id: "fake", deduplicated: 0 });
			}
			if (request.method === "GET" && path === "/mental-models") {
				if (!store.hasBank(bank)) return bankMissing;
				const models = await store.mentalModels(bank);
				return Response.json({
					items: models.map((model) => ({
						id: model.id,
						content: model.content,
						tags: [`role:${model.role}`],
						refreshed_at: model.refreshedAt,
					})),
				});
			}
			if (request.method === "POST" && path === "/mental-models") {
				if (!store.hasBank(bank)) return bankMissing;
				const body = (await request.json()) as CreateMentalModelBody;
				await store.createMentalModel(bank, {
					id: body.id,
					name: body.name,
					sourceQuery: body.source_query,
					tags: body.tags ?? [],
					maxTokens: body.max_tokens ?? 512,
				});
				return Response.json({ id: body.id });
			}
			const refresh = path.match(/^\/mental-models\/([^/]+)\/refresh$/);
			if (request.method === "POST" && refresh?.[1]) {
				if (!store.hasBank(bank)) return bankMissing;
				// Refresh is a POST with no body; anything else is not this endpoint answering.
				if (request.body) return new Response("body", { status: 400 });
				try {
					await store.refreshMentalModel(bank, decodeURIComponent(refresh[1]));
				} catch (error) {
					if (error instanceof StoreError && error.status === 404) {
						return new Response("not found", { status: 404 });
					}
					throw error;
				}
				return Response.json({ id: decodeURIComponent(refresh[1]) });
			}
			if (request.method === "POST" && path === "/memories/recall") {
				if (!store.hasBank(bank)) return bankMissing;
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
				if (!store.hasBank(bank)) return bankMissing;
				const limit = Number(url.searchParams.get("limit") ?? 100);
				const offset = Number(url.searchParams.get("offset") ?? 0);
				// Hindsight's documented default for the list endpoint is `any`.
				const tagsMatch = (url.searchParams.get("tags_match") ?? "any") as TagsMatch;
				const page = await store.listPage(bank, {
					limit,
					offset,
					tagsMatch,
					...(tags.length > 0 ? { tags } : {}),
				});
				return Response.json({ items: page.items.map(wire), total: page.total, limit, offset });
			}
			if (request.method === "GET" && path === "/tags") {
				if (!store.hasBank(bank)) return bankMissing;
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
				if (!uuidPattern.test(single[1])) {
					return Response.json({ detail: `Invalid memory_id: '${single[1]}'` }, { status: 400 });
				}
				const record = await store.get(bank, decodeURIComponent(single[1]));
				return record ? Response.json(wire(record)) : new Response("not found", { status: 404 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}
