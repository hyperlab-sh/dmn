import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TagCount } from "../store/types.js";

export interface MemoryUses {
	useCount: number;
	firstSeenAt: string | null;
	lastUsedAt: string | null;
}

export interface LocalStateOptions {
	/** Directory holding `state.sqlite`; created when missing. */
	directory: string;
	clock?: () => Date;
}

const schema = `
CREATE TABLE IF NOT EXISTS uses (
	memory_id TEXT PRIMARY KEY,
	use_count INTEGER NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS use_events (
	memory_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	at TEXT NOT NULL,
	UNIQUE (memory_id, turn_id)
);
CREATE TABLE IF NOT EXISTS dormant (
	memory_id TEXT PRIMARY KEY,
	dormant_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS co_use (
	a TEXT NOT NULL,
	b TEXT NOT NULL,
	weight REAL NOT NULL,
	PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS tag_fan_cache (
	bank TEXT NOT NULL,
	tag TEXT NOT NULL,
	count INTEGER NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (bank, tag)
);
`;

/** Use counts, dormancy and the tag fan cache. dmn's own bookkeeping; the store is never patched. */
export class LocalState {
	private readonly database: Database;
	private readonly clock: () => Date;

	constructor(options: LocalStateOptions) {
		mkdirSync(options.directory, { recursive: true });
		this.clock = options.clock ?? (() => new Date());
		this.database = new Database(join(options.directory, "state.sqlite"), { create: true });
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec(schema);
	}

	close(): void {
		this.database.close();
	}

	uses(memoryId: string): MemoryUses {
		const row = this.database
			.query<{ use_count: number; first_seen_at: string; last_used_at: string }, [string]>(
				"SELECT use_count, first_seen_at, last_used_at FROM uses WHERE memory_id = ?",
			)
			.get(memoryId);
		if (!row) return { useCount: 0, firstSeenAt: null, lastUsedAt: null };
		return {
			useCount: row.use_count,
			firstSeenAt: row.first_seen_at,
			lastUsedAt: row.last_used_at,
		};
	}

	/** Counts one use per memory per turn; a repeat for the same turn is ignored. */
	recordUse(memoryId: string, turnId: string): void {
		const at = this.clock().toISOString();
		this.database.transaction(() => {
			const inserted = this.database
				.query("INSERT OR IGNORE INTO use_events (memory_id, turn_id, at) VALUES (?, ?, ?)")
				.run(memoryId, turnId, at);
			if (inserted.changes === 0) return;
			this.database
				.query(
					`INSERT INTO uses (memory_id, use_count, first_seen_at, last_used_at)
					 VALUES (?, 1, ?, ?)
					 ON CONFLICT (memory_id) DO UPDATE SET
						use_count = use_count + 1, last_used_at = excluded.last_used_at`,
				)
				.run(memoryId, at, at);
		})();
	}

	isDormant(memoryId: string): boolean {
		return this.database.query("SELECT 1 FROM dormant WHERE memory_id = ?").get(memoryId) !== null;
	}

	setDormant(memoryId: string): void {
		this.database
			.query("INSERT OR IGNORE INTO dormant (memory_id, dormant_at) VALUES (?, ?)")
			.run(memoryId, this.clock().toISOString());
	}

	/** The only delete in dmn: removes a dormancy row, never a memory. */
	revive(memoryId: string): void {
		this.database.query("DELETE FROM dormant WHERE memory_id = ?").run(memoryId);
	}

	readonly tagFanCache = {
		/** Cached counts for a bank, or null when none is newer than `maxAgeMs`. */
		read: (bank: string, maxAgeMs: number): TagCount[] | null => {
			const cutoff = new Date(this.clock().getTime() - maxAgeMs).toISOString();
			const rows = this.database
				.query<TagCount, [string, string]>(
					"SELECT tag, count FROM tag_fan_cache WHERE bank = ? AND at >= ?",
				)
				.all(bank, cutoff);
			return rows.length > 0 ? rows : null;
		},
		write: (bank: string, counts: TagCount[]): void => {
			const at = this.clock().toISOString();
			const upsert = this.database.query(
				"INSERT OR REPLACE INTO tag_fan_cache (bank, tag, count, at) VALUES (?, ?, ?, ?)",
			);
			this.database.transaction(() => {
				for (const { tag, count } of counts) upsert.run(bank, tag, count, at);
			})();
		},
	};
}
