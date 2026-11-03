import type { Role } from "../cue/cue.js";
import { estimateTokens } from "../recall/inject.js";
import type { MemoryStore, MentalModel } from "../store/types.js";

/** The roles the roster summarizes; `unknown` is not a role with a memory of its own. */
export type RosterRole = Exclude<Role, "unknown">;

/** The four known roles, in the order the roster sync creates their models. */
export const rosterRoles: readonly RosterRole[] = [
	"architect",
	"developer",
	"reviewer",
	"operator",
];

/** The id (and name) of the mental model the roster keeps for one role. */
export const rosterModelId = (role: RosterRole): string => `dmn-role-${role}`;

/** The source query every role model is built from, pinned by D31. */
export const rosterSourceQuery = (role: RosterRole): string =>
	`What the ${role} role's memories cover: the facts, decisions and habits this role relies on`;

export interface SyncRosterOptions {
	/** Receives non-fatal problems (a refused create or refresh); stderr in the CLI. */
	onWarning?: (message: string) => void;
}

/**
 * Step 3 of rest: one mental model per role for the bank (AC-18, D31). The missing models are
 * created with the pinned shape and every one is refreshed, so the store rebuilds its content
 * from that role's memories. A create or refresh the store refuses is one warning and the run
 * moves on to the next role; a listing that fails throws, which makes the bank's pass fail.
 */
export async function syncRoster(
	store: MemoryStore,
	bank: string,
	roles: readonly RosterRole[],
	{ onWarning }: SyncRosterOptions = {},
): Promise<void> {
	const present = new Set((await store.mentalModels(bank)).map((model) => model.id));
	for (const role of roles) {
		if (!present.has(rosterModelId(role))) {
			try {
				await store.createMentalModel(bank, {
					id: rosterModelId(role),
					name: rosterModelId(role),
					sourceQuery: rosterSourceQuery(role),
					tags: [`role:${role}`],
					maxTokens: 512,
				});
			} catch (error) {
				onWarning?.(
					`dmn: cannot create the ${role} roster model in ${bank}: ${(error as Error).message}`,
				);
				// Nothing was created, so there is nothing to refresh.
				continue;
			}
		}
		try {
			await store.refreshMentalModel(bank, rosterModelId(role));
		} catch (error) {
			onWarning?.(
				`dmn: cannot refresh the ${role} roster model in ${bank}: ${(error as Error).message}`,
			);
		}
	}
}

/**
 * The model's first sentence: up to the first `.`, `!` or `?` followed by a space or the end,
 * else the first 200 characters. Whitespace is flattened first, so a line stays one line.
 */
function firstSentence(content: string): string {
	const text = content.replace(/\s+/g, " ").trim();
	const end = /[.!?]( |$)/.exec(text);
	if (end) return text.slice(0, end.index + 1);
	return text.slice(0, 200).trimEnd();
}

/**
 * One line per model of another role with content to show — `[roster:<role>] <first sentence>`
 * — in the order given, until the budget runs out; a line that does not fit is dropped.
 */
export function rosterLines(
	models: ReadonlyArray<MentalModel>,
	ownRole: string,
	budgetTokens: number,
): string[] {
	const lines: string[] = [];
	for (const model of models) {
		if (model.role === ownRole) continue;
		const sentence = firstSentence(model.content);
		if (!sentence) continue;
		const line = `[roster:${model.role}] ${sentence}`;
		if (estimateTokens([...lines, line].join("\n")) > budgetTokens) continue;
		lines.push(line);
	}
	return lines;
}
