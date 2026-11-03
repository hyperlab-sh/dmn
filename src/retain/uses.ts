import type { LocalState } from "../state/state.js";

const markerPattern = /\[m:([A-Za-z0-9_-]+)\]/g;

/** Ids of the memories the text cites with their `[m:<id>]` marker, each once. */
export function extractUses(text: string): Set<string> {
	const ids = new Set<string>();
	for (const match of text.matchAll(markerPattern)) if (match[1]) ids.add(match[1]);
	return ids;
}

/**
 * Counts one use per id for the turn, under the turn's project; a repeat for the same turn
 * is ignored by the state. The only caller of `recordUse`: surfacing a memory never
 * reinforces it, citing does.
 */
export function recordUses(
	state: LocalState,
	ids: Iterable<string>,
	turnId: string,
	project: string,
): void {
	for (const id of ids) state.recordUse(id, turnId, project);
}

/**
 * Counts the memories an assistant turn cites, under the turn's project; returns the ids
 * counted. When `isKnown` is given, ids it rejects (made up, or pasted from elsewhere) are
 * ignored.
 */
export async function countCitedUses(
	state: LocalState,
	assistantText: string,
	turnId: string,
	project: string,
	isKnown: (id: string) => Promise<boolean> = async () => true,
): Promise<string[]> {
	const cited = [...extractUses(assistantText)];
	const known = await Promise.all(cited.map(isKnown));
	const ids = cited.filter((_, index) => known[index]);
	recordUses(state, ids, turnId, project);
	return ids;
}
