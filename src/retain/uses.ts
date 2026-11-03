import type { LocalState } from "../state/state.js";

const markerPattern = /\[m:([A-Za-z0-9_-]+)\]/g;

/** Ids of the memories the text cites with their `[m:<id>]` marker, each once. */
export function extractUses(text: string): Set<string> {
	const ids = new Set<string>();
	for (const match of text.matchAll(markerPattern)) if (match[1]) ids.add(match[1]);
	return ids;
}

/**
 * Counts one use per id for the turn; a repeat for the same turn is ignored by the state.
 * The only caller of `recordUse`: surfacing a memory never reinforces it, citing does.
 */
export function recordUses(state: LocalState, ids: Iterable<string>, turnId: string): void {
	for (const id of ids) state.recordUse(id, turnId);
}

/** Counts the memories an assistant turn cites; returns their ids. */
export function countCitedUses(state: LocalState, assistantText: string, turnId: string): string[] {
	const ids = [...extractUses(assistantText)];
	recordUses(state, ids, turnId);
	return ids;
}
