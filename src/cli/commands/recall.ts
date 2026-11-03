import { parseArgs } from "node:util";
import { ConfigError, createStore, loadConfig, openState } from "../../config/config.js";
import { buildCue } from "../../cue/cue.js";
import { scanCueInput } from "../../cue/scan.js";
import { rosterRoles } from "../../roster/roster.js";
import { bankFor } from "../../store/hindsight.js";

/** `--top` is a positive integer; anything else refuses the command. */
function readTop(value: string): number {
	const topK = Number(value);
	if (!Number.isInteger(topK) || topK < 1) throw new Error("--top must be a positive integer");
	return topK;
}

/**
 * Runs `dmn recall --role <r> [--top N]`: one `[m:<id>] <text>` line per memory of that role,
 * in store order over the cue's two banks, dormant ids dropped, no activation rerank. Returns
 * the exit code.
 */
export async function runRecall(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<number> {
	let values: { role?: string; top?: string };
	try {
		({ values } = parseArgs({
			args,
			options: { role: { type: "string" }, top: { type: "string" } },
			strict: true,
		}));
	} catch (error) {
		process.stderr.write(`dmn: recall: ${(error as Error).message}\n`);
		return 1;
	}
	const role = values.role;
	if (!role) {
		process.stderr.write("dmn: recall: --role is required\n");
		return 1;
	}
	if (!(rosterRoles as readonly string[]).includes(role)) {
		process.stderr.write(
			`dmn: recall: unknown role "${role}" (roles: ${rosterRoles.join(", ")})\n`,
		);
		return 1;
	}
	try {
		const config = loadConfig({ env });
		const topK = values.top === undefined ? config.topK : readTop(values.top);
		const state = await openState(config);
		try {
			// The cue comes from the working directory alone; its organization picks the bank.
			const cue = buildCue(
				scanCueInput({ cwd: process.cwd(), organizations: config.organizations }),
			);
			const store = createStore(config);
			// Exactly the cue's two banks, as every recall (C-1); the role tag does the selecting.
			const banks = [...new Set([bankFor(cue.organization), bankFor(undefined)])];
			const seen = new Set<string>();
			for (const bank of banks) {
				const found = await store.recall(bank, {
					query: `${role} role`,
					tags: [`role:${role}`],
					tagsMatch: "all",
					topK,
				});
				for (const memory of found) {
					if (seen.has(memory.id) || state.isDormant(memory.id)) continue;
					seen.add(memory.id);
					process.stdout.write(`[m:${memory.id}] ${memory.text.replace(/\s+/g, " ").trim()}\n`);
				}
			}
			return 0;
		} finally {
			state.close();
		}
	} catch (error) {
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return error instanceof ConfigError ? 2 : 1;
	}
}
