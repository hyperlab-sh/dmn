import { ConfigError, createStore, loadConfig, openState } from "../../config/config.js";
import {
	HookEventError,
	type HookEventName,
	handleHookEvent,
	parseHookEvent,
} from "../../hooks/claude-code.js";

const eventBySubcommand: Record<string, HookEventName> = {
	"session-start": "SessionStart",
	"user-prompt": "UserPromptSubmit",
	"post-tool": "PostToolUse",
	stop: "Stop",
};

/** Small seeded generator (mulberry32) so a session's noise is stable and tests are exact. */
function seededRandom(seed: string): () => number {
	let state = 2166136261;
	for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** Runs `dmn hook <subcommand>`; returns the exit code. Output is the hook JSON, or nothing. */
export async function runHook(
	subcommand: string | undefined,
	env: Record<string, string | undefined>,
): Promise<number> {
	const expected = subcommand ? eventBySubcommand[subcommand] : undefined;
	if (!expected) {
		process.stderr.write(
			`dmn: unknown hook "${subcommand ?? ""}" (use ${Object.keys(eventBySubcommand).join(", ")})\n`,
		);
		return 1;
	}
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig({ env });
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`dmn: ${error.message}\n`);
			// Exit 2 is C-3's contract for user-prompt. Elsewhere Claude Code reads it as "block":
			// a Stop hook would refuse to let the turn end, so those exit 1 (non-blocking).
			return subcommand === "user-prompt" ? 2 : 1;
		}
		throw error;
	}
	try {
		const event = parseHookEvent(await readStdin());
		if (event.name !== expected) {
			throw new HookEventError(`hook ${subcommand} received a ${event.name} event`);
		}
		// Nothing to do until the intrusive path lands: no state, no store.
		if (event.name === "PostToolUse") return 0;
		const state = await openState(config);
		try {
			const output = await handleHookEvent(event, {
				store: createStore(config),
				state,
				config,
				// DMN_SEED is for tests; otherwise a session's noise is stable per session id.
				random: seededRandom(env.DMN_SEED ?? event.sessionId),
				// DMN_NOW (ISO date) is for tests, next to DMN_SEED.
				...(env.DMN_NOW && { now: new Date(env.DMN_NOW) }),
				onWarning: (message) => process.stderr.write(`${message}\n`),
			});
			if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
		} finally {
			state.close();
		}
		return 0;
	} catch (error) {
		process.stderr.write(`dmn: hook ${subcommand} failed: ${(error as Error).message}\n`);
		return 1;
	}
}
