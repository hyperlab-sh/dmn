import type { Config } from "../config/config.js";
import type { LocalState } from "../state/state.js";
import { isBankNotFound } from "../store/errors.js";
import { bankFor, isOrganizationTag } from "../store/hindsight.js";
import type { ConsolidationResult, MemoryRecord, MemoryStore } from "../store/types.js";

/** The scopes a memory can live at; promotion widens `project` → `organization` → `generic`. */
export type Scope = "project" | "organization" | "generic";

/** One learning whose use crossed projects, with the copy `--apply` would retain. */
export interface PromotionProposal {
	id: string;
	fromScope: Exclude<Scope, "generic">;
	toScope: Exclude<Scope, "project">;
	fromBank: string;
	toBank: string;
	/** The distinct projects that cited the memory, sorted. */
	projects: string[];
	content: string;
	/** The memory's tags minus the scope tags the promotion drops. */
	tags: string[];
	context?: string;
}

/** What rest did with one bank, in the order the banks were given. */
export interface BankRest {
	bank: string;
	/** The store's consolidation, or null when the store does not know the bank. */
	consolidation: ConsolidationResult | null;
	/** Why this bank's pass failed, when it did; the run continued past it and the exit is 1. */
	error?: string;
	/** Memories tagged `kind:learning` the bank holds, before the skips. */
	learnings: number;
	proposals: PromotionProposal[];
	/** Ids applied this run, in proposal order. */
	applied: string[];
	/** Ids whose promotion the store refused this run; their originals were left as they were. */
	failed: string[];
}

export interface RestReport {
	banks: BankRest[];
}

export interface RestOptions {
	/** Defaults to `generic` and every bank of `config.organizations`. */
	banks?: string[];
	/** Retain the copies, mark the originals dormant, record the promotions. Default: report only. */
	apply?: boolean;
	now: Date;
	/** Receives non-fatal problems (a refused promotion, a failed bank); stderr in the CLI. */
	onWarning?: (message: string) => void;
	/** Step 3 of rest: the roster sync, one mental model per role (AC-18). */
	syncRoster?: (bank: string) => Promise<void> | void;
	/** Memories fetched per store call. */
	pageSize?: number;
}

/** Lists the bank's memories tagged `kind:learning`, paged to the end. */
async function listLearnings(
	store: MemoryStore,
	bank: string,
	pageSize: number,
): Promise<MemoryRecord[]> {
	const memories: MemoryRecord[] = [];
	for (let offset = 0; ; offset += pageSize) {
		const page = await store.list(bank, { tags: ["kind:learning"], limit: pageSize, offset });
		memories.push(...page);
		if (page.length < pageSize) break;
	}
	return memories;
}

/**
 * The proposal for a learning used in two or more projects: a project-tagged learning widens to
 * its organization scope (same bank, without the `project:` tag); an organization learning
 * widens to `generic`. A copy entering the `generic` bank carries no organization tag, and a
 * project-tagged learning already living there widens within it to generic scope. A learning
 * already at the widest scope of its bank has no proposal.
 */
function proposalFor(
	bank: string,
	generic: string,
	memory: MemoryRecord,
	projects: string[],
): PromotionProposal | undefined {
	const hasProjectTag = memory.tags.some((tag) => tag.startsWith("project:"));
	// Already as wide as the generic bank gets: nowhere to promote to.
	if (!hasProjectTag && bank === generic) return undefined;
	const toBank = hasProjectTag ? bank : generic;
	return {
		id: memory.id,
		fromScope: hasProjectTag ? "project" : "organization",
		toScope: toBank === generic ? "generic" : "organization",
		fromBank: bank,
		toBank,
		projects,
		content: memory.text,
		tags: memory.tags.filter(
			(tag) => !tag.startsWith("project:") && !(toBank === generic && isOrganizationTag(tag)),
		),
		...(memory.context !== undefined && { context: memory.context }),
	};
}

/**
 * Rest state for every bank: the store's own consolidation, then the promotion report for
 * learnings used in two or more projects — applied only with `apply`. Without it nothing is
 * written to the store or to `promotions`; the originals are made dormant, never deleted.
 * One bank's failure is recorded on its entry and the run continues with the others.
 */
export async function runRest(
	store: MemoryStore,
	state: LocalState,
	config: Config,
	{ banks, apply = false, now, onWarning, syncRoster, pageSize = 100 }: RestOptions,
): Promise<RestReport> {
	const generic = bankFor(undefined);
	const report: RestReport = { banks: [] };
	for (const bank of banks ?? [
		...new Set(
			[undefined, ...Object.values(config.organizations)].map((organization) =>
				bankFor(organization),
			),
		),
	]) {
		const entry: BankRest = {
			bank,
			consolidation: null,
			learnings: 0,
			proposals: [],
			applied: [],
			failed: [],
		};
		report.banks.push(entry);
		try {
			try {
				entry.consolidation = await store.consolidate(bank);
			} catch (error) {
				// A bank nobody has written to is skipped, not an error.
				if (isBankNotFound(error)) continue;
				throw error;
			}
			const learnings = await listLearnings(store, bank, pageSize);
			entry.learnings = learnings.length;
			for (const memory of learnings) {
				// Applied once, never again; a dormant original is done surfacing.
				if (state.isPromoted(memory.id) || state.isDormant(memory.id)) continue;
				const projects = state.projectsUsing(memory.id);
				if (projects.length < 2) continue;
				const proposal = proposalFor(bank, generic, memory, projects);
				if (!proposal) continue;
				entry.proposals.push(proposal);
				if (!apply) continue;
				try {
					// async: false — a promotion the store refused must be heard, not queued away.
					await store.retain(
						proposal.toBank,
						[
							{
								content: proposal.content,
								tags: proposal.tags,
								...(proposal.context !== undefined && { context: proposal.context }),
								// A repeated apply replaces the copy instead of duplicating it.
								documentId: `promotion:${proposal.id}`,
								metadata: { promoted_from: proposal.id, promoted_at: now.toISOString() },
							},
						],
						{ async: false },
					);
					// One write: a crash cannot leave the original dormant but unrecorded.
					state.markPromoted(proposal.id, proposal.toScope);
					entry.applied.push(proposal.id);
				} catch (error) {
					// The original keeps its scope and the promotion stays unrecorded: retriable.
					entry.failed.push(proposal.id);
					onWarning?.(`dmn: cannot promote ${proposal.id}: ${(error as Error).message}`);
				}
			}
			// Step 3: the roster sync — the missing role models are created, every one refreshed.
			// Inside the try: a roster that throws is this bank's failure, not the run's.
			await syncRoster?.(bank);
		} catch (error) {
			// The banks already processed keep their report; this one says what went wrong.
			entry.error = (error as Error).message;
			onWarning?.(`dmn: rest for bank ${bank} failed: ${entry.error}`);
		}
	}
	return report;
}
