import { intrusionDraw, intrusionNoise, seededRandom } from "../../activation/random.js";
import {
	ConfigError,
	createJudge,
	createStore,
	loadConfig,
	openState,
} from "../../config/config.js";
import {
	HookEventError,
	type HookEventName,
	handleHookEvent,
	parseHookEvent,
} from "../../hooks/claude-code.js";
import type { Judge } from "../../judge/types.js";

const eventBySubcommand: Record<string, HookEventName> = {
	"session-start": "SessionStart",
	"user-prompt": "UserPromptSubmit",
	"post-tool": "PostToolUse",
	stop: "Stop",
};

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function judgeDep(
	config: ReturnType<typeof loadConfig>,
	env: Record<string, string | undefined>,
): { judge?: Judge } {
	const judge = createJudge(config, env);
	return judge ? { judge } : {};
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
		// Intrusive thoughts off: no state, no store, no work after a tool call.
		if (event.name === "PostToolUse" && config.intrusionThreshold === null) return 0;

		const now = env.DMN_NOW ? new Date(env.DMN_NOW) : undefined;
		if (now && Number.isNaN(now.getTime())) throw new Error("DMN_NOW is not an ISO date");
		// Under DMN_NOW the use stamps follow the same clock as recall.
		const seed = env.DMN_SEED ?? event.sessionId;
		const state = await openState(config, now && (() => now));
		// An intrusive thought is optional: it gets its own short limit, not the prompt's.
		const storeConfig =
			event.name === "PostToolUse"
				? { ...config, storeTimeoutMs: config.intrusionTimeoutMs }
				: config;
		try {
			const output = await handleHookEvent(event, {
				store: createStore(storeConfig),
				state,
				config,
				// Provider "none" builds no judge, so no code path can reach the network.
				...judgeDep(config, env),
				// DMN_SEED is for tests; otherwise a session's noise is stable per session id.
				random: seededRandom(seed),
				// Each tool call draws on its own: a fresh process would replay the session's draws.
				// Without a tool_use_id only DMN_SEED (tests) may repeat them; otherwise draw freely.
				...(event.name === "PostToolUse" &&
					(event.toolUseId
						? {
								random: intrusionNoise(seed, event.toolUseId),
								draw: () => intrusionDraw(seed, event.toolUseId as string),
							}
						: !env.DMN_SEED && { random: Math.random })),
				// DMN_NOW (ISO date) is for tests, next to DMN_SEED.
				...(now && { now }),
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
