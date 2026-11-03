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

/**
 * One store surface for recall, hooks and replay. Every call takes exactly one bank;
 * choosing banks is the caller's job through `bankFor`.
 */
export interface MemoryStore {
	retain(bank: string, items: RetainItem[]): Promise<void>;
	recall(bank: string, query: RecallQuery): Promise<MemoryRecord[]>;
	get(bank: string, id: string): Promise<MemoryRecord | null>;
	list(bank: string, query: ListQuery): Promise<MemoryRecord[]>;
	listTags(bank: string): Promise<TagCount[]>;
}
