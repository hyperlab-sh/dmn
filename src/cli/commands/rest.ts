import { parseArgs } from "node:util";
import { ConfigError, createStore, loadConfig, openState } from "../../config/config.js";
import { type RestReport, runRest } from "../../rest/rest.js";

/**
 * Prints one line per bank of the report; returns the exit code. A bank whose pass failed, or
 * one whose promotion the store refused, costs the exit — the report itself always prints.
 */
export function printRest(
	report: RestReport,
	apply: boolean,
	write: (line: string) => void = (line) => process.stdout.write(line),
): number {
	let failed = false;
	for (const entry of report.banks) {
		if (entry.error !== undefined) {
			write(`failed ${entry.bank}: ${entry.error}\n`);
			failed = true;
			continue;
		}
		if (entry.consolidation === null) {
			write(`skipped ${entry.bank}: not found\n`);
			continue;
		}
		write(`consolidated ${entry.bank}: ${entry.consolidation.deduplicated} deduplicated\n`);
		if (entry.learnings === 0) {
			write(`no memory tagged kind:learning in ${entry.bank}\n`);
			continue;
		}
		for (const proposal of entry.proposals) {
			write(
				`promote ${proposal.id} ${proposal.fromScope} → ${proposal.toScope} (projects: ${proposal.projects.join(", ")})\n`,
			);
		}
		if (entry.proposals.length === 0) {
			write(`nothing to promote in ${entry.bank}\n`);
		} else if (apply) {
			for (const id of entry.applied) write(`promoted ${id}\n`);
		}
		// A refused promotion was warned about on stderr; the exit must say it too.
		if (entry.failed.length > 0) failed = true;
	}
	return failed ? 1 : 0;
}

/** Runs `dmn rest [--apply] [--bank <b>...]`; returns the exit code. */
export async function runRestCommand(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<number> {
	let values: { apply?: boolean; bank?: string[] };
	try {
		({ values } = parseArgs({
			args,
			options: {
				apply: { type: "boolean" },
				bank: { type: "string", multiple: true },
			},
			strict: true,
		}));
	} catch (error) {
		process.stderr.write(`dmn: rest: ${(error as Error).message}\n`);
		return 1;
	}
	try {
		const config = loadConfig({ env });
		// DMN_NOW (ISO date) is for tests, as in `dmn sweep`.
		const now = env.DMN_NOW ? new Date(env.DMN_NOW) : new Date();
		if (Number.isNaN(now.getTime())) throw new Error("DMN_NOW is not an ISO date");
		const state = await openState(config, () => now);
		try {
			const report = await runRest(createStore(config), state, config, {
				// --bank names banks; without it rest takes generic and every organization bank.
				...(values.bank && { banks: values.bank }),
				apply: values.apply === true,
				now,
				onWarning: (message) => process.stderr.write(`${message}\n`),
			});
			return printRest(report, values.apply === true);
		} finally {
			state.close();
		}
	} catch (error) {
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return error instanceof ConfigError ? 2 : 1;
	}
}
