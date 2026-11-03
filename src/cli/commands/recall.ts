import { parseArgs } from "node:util";
import { ConfigError, createStore, loadConfig, openState } from "../../config/config.js";
import { buildCue } from "../../cue/cue.js";
import { scanCueInput } from "../../cue/scan.js";
import { rosterRoles } from "../../roster/roster.js";
import { bankFor } from "../../store/hindsight.js";

/** Where a command's output goes; the process streams by default, tests collect. */
export interface CommandIo {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const processIo: CommandIo = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

/** `--top` is a positive integer; anything else refuses the command. */
function readTop(value: string): number {
	const topK = Number(value);
	if (!Number.isInteger(topK) || topK < 1) throw new Error("--top must be a positive integer");
	return topK;
}

/**
 * Runs `dmn recall --role <r> [--top N]`: one `[m:<id>] <text>` line per memory of that role,
 * in store order over the cue's two banks, dormant ids dropped, no activation rerank. `--top`
 * caps the printed lines across both banks together, not per bank. Returns the exit code.
 */
export async function runRecall(
	args: string[],
	env: Record<string, string | undefined>,
	io: CommandIo = processIo,
): Promise<number> {
	let values: { role?: string; top?: string };
	try {
		({ values } = parseArgs({
			args,
			options: { role: { type: "string" }, top: { type: "string" } },
			strict: true,
		}));
	} catch (error) {
		io.stderr(`dmn: recall: ${(error as Error).message}\n`);
		return 1;
	}
	const role = values.role;
	if (!role) {
		io.stderr("dmn: recall: --role is required\n");
		return 1;
	}
	if (!(rosterRoles as readonly string[]).includes(role)) {
		io.stderr(`dmn: recall: unknown role "${role}" (roles: ${rosterRoles.join(", ")})\n`);
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
			let printed = 0;
			let dropped = 0;
			for (const bank of banks) {
				if (printed >= topK) break;
				// Over-fetch by what dormant ids already cost, so a drop cannot short the list;
				// when a whole page was drops, ask the bank deeper before moving on.
				let limit = topK + dropped;
				while (printed < topK) {
					const found = await store.recall(bank, {
						query: `${role} role`,
						tags: [`role:${role}`],
						tagsMatch: "all",
						topK: limit,
					});
					if (found.length === 0) break;
					for (const memory of found) {
						if (printed >= topK) break;
						if (seen.has(memory.id)) continue;
						if (state.isDormant(memory.id)) {
							dropped += 1;
							continue;
						}
						seen.add(memory.id);
						printed += 1;
						io.stdout(`[m:${memory.id}] ${memory.text.replace(/\s+/g, " ").trim()}\n`);
					}
					// A short page means the bank is exhausted; a full page with lines left to
					// print was all drops and duplicates — look deeper, not elsewhere.
					if (found.length < limit || printed >= topK) break;
					limit += topK;
				}
			}
			return 0;
		} finally {
			state.close();
		}
	} catch (error) {
		io.stderr(`dmn: ${(error as Error).message}\n`);
		return error instanceof ConfigError ? 2 : 1;
	}
}
