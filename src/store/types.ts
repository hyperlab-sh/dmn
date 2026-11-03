/** How Hindsight combines `tags` with a memory's own tags. `any`/`all` also match untagged memories. */
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict" | "exact";

export interface MemoryScore {
	final: number;
	semantic?: number;
	keyword?: number;
	reranker?: number;
}

export interface MemoryRecord {
	id: string;
	text: string;
	tags: string[];
	createdAt: string;
	context?: string;
	metadata?: Record<string, string>;
	score?: MemoryScore;
}

export interface RetainItem {
	content: string;
	tags: string[];
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	/** When the content occurred (ISO 8601); a record's `createdAt`, never the ingest time. */
	timestamp?: string;
}

export interface RecallQuery {
	query: string;
	tags?: string[];
	tagsMatch?: TagsMatch;
	topK: number;
	queryTimestamp?: string;
}

export interface ListQuery {
	tags?: string[];
	limit: number;
	offset: number;
}

export interface TagCount {
	tag: string;
	count: number;
}

/** What the store's own consolidation did: its operation id and how many items it merged. */
export interface ConsolidationResult {
	operationId: string;
	deduplicated: number;
}

/**
 * One of the store's mental models. dmn's roster keeps one per role per bank (D31); a model
 * without a `role:` tag is not dmn's and is skipped by `mentalModels`.
 */
export interface MentalModel {
	id: string;
	role: string;
	content: string;
	refreshedAt: string;
}

/** The mental model `createMentalModel` posts, in the store's own terms. */
export interface MentalModelInput {
	id: string;
	name: string;
	sourceQuery: string;
	tags: string[];
	maxTokens: number;
}

/**
 * One store surface for recall, hooks and replay. Every call takes exactly one bank;
 * choosing banks is the caller's job through `bankFor`.
 */
export interface MemoryStore {
	/** `async: true` returns once the store has accepted the items, before it extracts facts. */
	retain(bank: string, items: RetainItem[], options?: { async?: boolean }): Promise<void>;
	/** The store's own maintenance for the bank; no body is sent. */
	consolidate(bank: string): Promise<ConsolidationResult>;
	recall(bank: string, query: RecallQuery): Promise<MemoryRecord[]>;
	get(bank: string, id: string): Promise<MemoryRecord | null>;
	list(bank: string, query: ListQuery): Promise<MemoryRecord[]>;
	listTags(bank: string): Promise<TagCount[]>;
	/** The bank's mental models, each with the role its `role:<r>` tag names; others are skipped. */
	mentalModels(bank: string): Promise<MentalModel[]>;
	/** Creates a mental model in the bank; dmn only ever creates and refreshes, never edits one. */
	createMentalModel(bank: string, model: MentalModelInput): Promise<void>;
	/** Asks the store to rebuild the model from its source query; no body is sent. */
	refreshMentalModel(bank: string, id: string): Promise<void>;
}
