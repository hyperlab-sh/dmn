import type { Config } from "../config/config.js";
import { buildCue, type Cue } from "../cue/cue.js";
import { scanCueInput } from "../cue/scan.js";
import type { Judge, KindJudge } from "../judge/types.js";
import { estimateTokens, formatInjection } from "../recall/inject.js";
import { intrude } from "../recall/intrude.js";
import { recall } from "../recall/pipeline.js";
import { retainTurns } from "../retain/retain.js";
import { countCitedUses } from "../retain/uses.js";
import { rosterLines } from "../roster/roster.js";
import type { LocalState } from "../state/state.js";
import { bankFor } from "../store/hindsight.js";
import type { MemoryStore, MentalModel } from "../store/types.js";
import { lastTurns } from "../transcript/read.js";

export type HookEventName = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";

const hookEventNames: readonly HookEventName[] = [
	"SessionStart",
	"UserPromptSubmit",
	"PostToolUse",
	"Stop",
];

export type HookEvent = {
	name: HookEventName;
	sessionId: string;
	cwd: string;
	transcriptPath?: string;
	/** UserPromptSubmit. */
	prompt?: string;
	/** SessionStart: `startup`, `resume`, `clear` or `compact`. */
	source?: string;
	/** PostToolUse. */
	toolName?: string;
	toolInput?: unknown;
	toolResponse?: unknown;
	/** PostToolUse: Claude Code's id of this call; it seeds the call's own draw. */
	toolUseId?: string;
	/** Stop. */
	stopHookActive?: boolean;
};

/** What a hook prints, or null when it prints nothing. */
export type HookOutput = {
	hookSpecificOutput: { hookEventName: HookEventName; additionalContext: string };
} | null;

export interface HookDeps {
	store: MemoryStore;
	state: LocalState;
	config: Config;
	random?: () => number;
	/** The intrusive thought's decision draw; `random` when absent. */
	draw?: () => number;
	now?: Date;
	/** Gates prompt-time injections and intrusive thoughts, and classifies the kinds of the turns Stop retains; absent when `judge.provider` is `none`. */
	judge?: Judge & KindJudge;
	/** Receives non-fatal problems (a failed fan count); stderr in the CLI. */
	onWarning?: (message: string) => void;
}

export class HookEventError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HookEventError";
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Parses the JSON Claude Code writes on a hook's stdin. */
export function parseHookEvent(stdin: string): HookEvent {
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(stdin);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (error) {
		throw new HookEventError(`hook input is not valid JSON: ${(error as Error).message}`);
	}
	const name = raw.hook_event_name;
	if (!hookEventNames.includes(name as HookEventName)) {
		throw new HookEventError(`unsupported hook_event_name: ${JSON.stringify(name)}`);
	}
	const cwd = optionalString(raw.cwd);
	if (!cwd) throw new HookEventError("hook input has no cwd");
	const transcriptPath = optionalString(raw.transcript_path);
	const prompt = optionalString(raw.prompt);
	const source = optionalString(raw.source);
	const toolName = optionalString(raw.tool_name);
	const toolUseId = optionalString(raw.tool_use_id);
	return {
		name: name as HookEventName,
		sessionId: optionalString(raw.session_id) ?? "",
		cwd,
		...(transcriptPath && { transcriptPath }),
		...(prompt !== undefined && { prompt }),
		...(source && { source }),
		...(toolName && { toolName }),
		...(toolUseId && { toolUseId }),
		...("tool_input" in raw && { toolInput: raw.tool_input }),
		...("tool_response" in raw && { toolResponse: raw.tool_response }),
		...(typeof raw.stop_hook_active === "boolean" && { stopHookActive: raw.stop_hook_active }),
	};
}

function cueFor(event: HookEvent, config: Config): Cue {
	return buildCue(
		scanCueInput({
			cwd: event.cwd,
			...(event.transcriptPath && { transcriptPath: event.transcriptPath }),
			organizations: config.organizations,
		}),
	);
}

const judgeWarning = (onWarning: (message: string) => void) => (error: unknown) =>
	onWarning(`dmn: judge: ${(error as Error).message}`);

/**
 * The roster lines of a session start: one per other role whose model the cue's banks hold
 * something to say about — the first model with content wins, the organization bank first —
 * within the budget the memory lines left. A store that cannot be read costs the lines, not
 * the injection.
 */
async function sessionRosterLines(
	store: MemoryStore,
	cue: Cue,
	config: Config,
	memoryLines: string,
	onWarning?: (message: string) => void,
): Promise<string[]> {
	const banks = [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	try {
		const perBank = await Promise.all(banks.map((bank) => store.mentalModels(bank)));
		const seen = new Set<string>();
		const models: MentalModel[] = [];
		for (const model of perBank.flat()) {
			// A model with nothing to say yet does not shadow another bank's model for the same
			// role: the first model with content wins, and the organization bank is read first.
			if (seen.has(model.role) || model.content.trim() === "") continue;
			seen.add(model.role);
			models.push(model);
		}
		// The newline that would join the roster lines to the memory lines spends with them.
		const spent = memoryLines ? estimateTokens(`${memoryLines}\n`) : 0;
		return rosterLines(models, cue.role, config.budgetTokens - spent);
	} catch (error) {
		onWarning?.(`dmn: roster unavailable: ${(error as Error).message}`);
		return [];
	}
}

async function inject(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	const { store, state, config, random, now, onWarning, judge } = deps;
	const cue = cueFor(event, config);
	const ranked = await recall({
		store,
		state,
		config,
		cue,
		prompt: event.name === "UserPromptSubmit" ? event.prompt : undefined,
		...(onWarning && {
			onFanError: (bank, error) =>
				onWarning(`dmn: tag counts for bank ${bank} unavailable: ${(error as Error).message}`),
		}),
		...(judge && {
			judge,
			judgeThreshold: config.judge.threshold,
			...(onWarning && { onJudgeError: judgeWarning(onWarning) }),
		}),
		...(random && { random }),
		...(now && { now }),
	});
	const memoryLines = formatInjection(ranked, config.budgetTokens);
	// The roster is a session-start addition; a prompt event never repeats it.
	const roster =
		event.name === "SessionStart"
			? await sessionRosterLines(store, cue, config, memoryLines, onWarning)
			: [];
	const additionalContext = [...(memoryLines ? [memoryLines] : []), ...roster].join("\n");
	if (!additionalContext) return null;
	return { hookSpecificOutput: { hookEventName: event.name, additionalContext } };
}

/** Counts cited memories the store confirms, then retains the turns; a store that cannot confirm only costs the uses. */
async function finishTurn(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	// Our Stop hook never blocks, so a continuation is not ours; the turn was handled already.
	if (event.stopHookActive || !event.transcriptPath) return null;
	const turns = lastTurns(event.transcriptPath, event.sessionId);
	if (!turns) return null;
	const cue = cueFor(event, deps.config);
	const banks = [...new Set([bankFor(cue.organization), bankFor(undefined)])];
	// A cited id counts only when the store knows it: hallucinated markers earn nothing.
	const isKnown = async (id: string) => {
		try {
			return (await Promise.all(banks.map((bank) => deps.store.get(bank, id)))).some(Boolean);
		} catch (error) {
			// An unreachable store must not cost the turn its retention: skip the count, go on.
			deps.onWarning?.(`dmn: cannot resolve cited id ${id}: ${(error as Error).message}`);
			return false;
		}
	};
	const cited = await countCitedUses(
		deps.state,
		turns.assistant,
		turns.turnId,
		cue.project,
		isKnown,
	);
	deps.state.recordCoUse(cited, turns.turnId);
	await retainTurns(
		deps.store,
		cue,
		[
			{ role: "user", text: turns.user, documentId: turns.turnId },
			{ role: "assistant", text: turns.assistant, documentId: turns.turnId },
		],
		{
			now: deps.now ?? new Date(),
			// One classify call tags the kinds; a judge that fails or outlives the store limit
			// costs the tags, not the turn.
			...(deps.judge && {
				judge: deps.judge,
				kindThreshold: deps.config.judge.kindThreshold,
				judgeDeadlineMs: deps.config.storeTimeoutMs,
			}),
			...(deps.onWarning && { onJudgeError: judgeWarning(deps.onWarning) }),
		},
	);
	return null;
}

/** After a tool call, rarely, one memory as a single line; nothing otherwise. Never an error. */
async function intrusiveThought(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	const { store, state, config, random, draw, now, onWarning, judge } = deps;
	let memory: Awaited<ReturnType<typeof intrude>>;
	try {
		memory = await intrude({
			store,
			state,
			config,
			cue: cueFor(event, config),
			sessionId: event.sessionId,
			toolName: event.toolName ?? "",
			toolInput: event.toolInput,
			...(onWarning && {
				onFanError: (bank: string, error: unknown) =>
					onWarning(`dmn: tag counts for bank ${bank} unavailable: ${(error as Error).message}`),
			}),
			...(judge && { judge, ...(onWarning && { onJudgeError: judgeWarning(onWarning) }) }),
			...(random && { random }),
			...(draw && { draw }),
			...(now && { now }),
		});
	} catch (error) {
		// Optional noise must not cost the developer an error after every tool call.
		onWarning?.(`dmn: intrusive recall failed: ${(error as Error).message}`);
		return null;
	}
	if (!memory) return null;
	const additionalContext = formatInjection([memory], config.budgetTokens);
	// The cooldown restarts only with something printed.
	if (!additionalContext) return null;
	state.markIntrusion(event.sessionId);
	return { hookSpecificOutput: { hookEventName: event.name, additionalContext } };
}

/** One branch per event. */
export async function handleHookEvent(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	switch (event.name) {
		case "SessionStart":
		case "UserPromptSubmit":
			return inject(event, deps);
		case "Stop":
			return finishTurn(event, deps);
		case "PostToolUse":
			return intrusiveThought(event, deps);
	}
}
