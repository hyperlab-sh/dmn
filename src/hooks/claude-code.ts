import type { Config } from "../config/config.js";
import { buildCue, type Cue } from "../cue/cue.js";
import { scanCueInput } from "../cue/scan.js";
import { formatInjection } from "../recall/inject.js";
import { recall } from "../recall/pipeline.js";
import { retainTurns } from "../retain/retain.js";
import { countCitedUses } from "../retain/uses.js";
import type { LocalState } from "../state/state.js";
import type { MemoryStore } from "../store/types.js";
import { lastTurns } from "../transcript/read.js";

export type HookEventName = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";

export const hookEventNames: readonly HookEventName[] = [
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
	now?: Date;
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
	return {
		name: name as HookEventName,
		sessionId: optionalString(raw.session_id) ?? "",
		cwd,
		...(transcriptPath && { transcriptPath }),
		...(prompt !== undefined && { prompt }),
		...(source && { source }),
		...(toolName && { toolName }),
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

async function inject(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	const { store, state, config, random, now, onWarning } = deps;
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
		...(random && { random }),
		...(now && { now }),
	});
	const additionalContext = formatInjection(ranked, config.budgetTokens);
	if (!additionalContext) return null;
	return { hookSpecificOutput: { hookEventName: event.name, additionalContext } };
}

/** Counts cited memories first (local, cannot fail on the network), then retains the turns. */
async function finishTurn(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	if (!event.transcriptPath) return null;
	const turns = lastTurns(event.transcriptPath);
	if (!turns) return null;
	countCitedUses(deps.state, turns.assistant, turns.turnId);
	await retainTurns(
		deps.store,
		cueFor(event, deps.config),
		[
			{ role: "user", text: turns.user, documentId: turns.turnId },
			{ role: "assistant", text: turns.assistant, documentId: turns.turnId },
		],
		{ now: deps.now ?? new Date() },
	);
	return null;
}

/** One branch per event. `PostToolUse` only parses today; the intrusive path extends it. */
export async function handleHookEvent(event: HookEvent, deps: HookDeps): Promise<HookOutput> {
	switch (event.name) {
		case "SessionStart":
		case "UserPromptSubmit":
			return inject(event, deps);
		case "Stop":
			return finishTurn(event, deps);
		case "PostToolUse":
			return null;
	}
}
