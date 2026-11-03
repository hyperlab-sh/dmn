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
	project TEXT NOT NULL DEFAULT '',
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
	last_at TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS intrusions (
	session_id TEXT PRIMARY KEY,
	tool_calls_since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tag_fan_cache (
	bank TEXT NOT NULL,
	tag TEXT NOT NULL,
	count INTEGER NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (bank, tag)
);
CREATE TABLE IF NOT EXISTS promotions (
	memory_id TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	at TEXT NOT NULL
);
`;

/** Use counts, dormancy and the tag fan cache. dmn's own bookkeeping; the store is never patched. */
export class LocalState {
	private readonly database: Database;
	private readonly clock: () => Date;

	constructor({ directory, clock = () => new Date() }: LocalStateOptions) {
		mkdirSync(directory, { recursive: true });
		this.clock = clock;
		this.database = new Database(join(directory, "state.sqlite"), { create: true });
		this.database.exec("PRAGMA busy_timeout = 2000");
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec(schema);
		// co_use shipped without last_at; add it to state files created before.
		const columns = this.database.query<{ name: string }, []>("PRAGMA table_info(co_use)").all();
		if (!columns.some((column) => column.name === "last_at")) {
			this.database.exec("ALTER TABLE co_use ADD COLUMN last_at TEXT NOT NULL DEFAULT ''");
		}
		// use_events shipped without project (D29); add it to state files created before.
		const eventColumns = this.database
			.query<{ name: string }, []>("PRAGMA table_info(use_events)")
			.all();
		if (!eventColumns.some((column) => column.name === "project")) {
			this.database.exec("ALTER TABLE use_events ADD COLUMN project TEXT NOT NULL DEFAULT ''");
		}
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

	/**
	 * Counts one use per memory per turn, under the project of the session that cited it; a
	 * repeat for the same turn is ignored.
	 */
	recordUse(memoryId: string, turnId: string, project: string): void {
		const at = this.clock().toISOString();
		this.database.transaction(() => {
			const inserted = this.database
				.query(
					"INSERT OR IGNORE INTO use_events (memory_id, turn_id, at, project) VALUES (?, ?, ?, ?)",
				)
				.run(memoryId, turnId, at, project);
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

	/**
	 * Strengthens the association of every pair of distinct ids cited in one turn (weight += 1,
	 * `a < b`). A repeat for the same turn is ignored; fewer than two ids write nothing.
	 */
	recordCoUse(ids: ReadonlyArray<string>, turnId: string): void {
		const unique = [...new Set(ids)].sort();
		if (unique.length < 2) return;
		const at = this.clock().toISOString();
		this.database.transaction(() => {
			for (let i = 0; i < unique.length; i++) {
				for (let j = i + 1; j < unique.length; j++) {
					const a = unique[i] as string;
					const b = unique[j] as string;
					// The length prefix keeps pair keys unambiguous for any id; "co:" cannot start a memory
					// id's own use_events row because those never contain ":".
					const inserted = this.database
						.query("INSERT OR IGNORE INTO use_events (memory_id, turn_id, at) VALUES (?, ?, ?)")
						.run(`co:${a.length}:${a}:${b}`, turnId, at);
					if (inserted.changes === 0) continue;
					this.database
						.query(
							`INSERT INTO co_use (a, b, weight, last_at) VALUES (?, ?, 1, ?)
							 ON CONFLICT (a, b) DO UPDATE SET weight = weight + 1, last_at = excluded.last_at`,
						)
						.run(a, b, at);
				}
			}
		})();
	}

	/** The memories co-cited with `memoryId` and the strength of each association. */
	associations(memoryId: string): { id: string; weight: number }[] {
		return this.database
			.query<{ id: string; weight: number }, [string, string]>(
				`SELECT b AS id, weight FROM co_use WHERE a = ?
				 UNION ALL SELECT a AS id, weight FROM co_use WHERE b = ?
				 ORDER BY id`,
			)
			.all(memoryId, memoryId);
	}

	/** How many memories are associated with `memoryId`. */
	associationFan(memoryId: string): number {
		return this.associations(memoryId).length;
	}

	/** The distinct, non-empty projects whose sessions cited `memoryId`, sorted. */
	projectsUsing(memoryId: string): string[] {
		return this.database
			.query<{ project: string }, [string]>(
				"SELECT DISTINCT project FROM use_events WHERE memory_id = ? AND project <> '' ORDER BY project",
			)
			.all(memoryId)
			.map((row) => row.project);
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

	/** Remembers an applied promotion; a memory with a row is never proposed again. */
	recordPromotion(memoryId: string, scope: string): void {
		this.database
			.query("INSERT OR IGNORE INTO promotions (memory_id, scope, at) VALUES (?, ?, ?)")
			.run(memoryId, scope, this.clock().toISOString());
	}

	isPromoted(memoryId: string): boolean {
		return (
			this.database.query("SELECT 1 FROM promotions WHERE memory_id = ?").get(memoryId) !== null
		);
	}

	/**
	 * Tool calls since the session's last intrusion, not counting the current one.
	 * Infinity until the session has had one: the cooldown only follows an emission.
	 */
	toolCallsSince(sessionId: string): number {
		const row = this.database
			.query<{ tool_calls_since: number }, [string]>(
				"SELECT tool_calls_since FROM intrusions WHERE session_id = ?",
			)
			.get(sessionId);
		return row ? row.tool_calls_since : Number.POSITIVE_INFINITY;
	}

	/** Counts one tool call toward the cooldown; a session without an intrusion has none to count. */
	bumpToolCalls(sessionId: string): void {
		this.database
			.query("UPDATE intrusions SET tool_calls_since = tool_calls_since + 1 WHERE session_id = ?")
			.run(sessionId);
	}

	/** Starts the cooldown: the session's next intrusion waits for the configured number of calls. */
	markIntrusion(sessionId: string): void {
		this.database
			.query(
				`INSERT INTO intrusions (session_id, tool_calls_since) VALUES (?, 0)
				 ON CONFLICT (session_id) DO UPDATE SET tool_calls_since = 0`,
			)
			.run(sessionId);
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
