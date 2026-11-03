import { parseArgs } from "node:util";
import { ConfigError, createStore, loadConfig, openState } from "../../config/config.js";
import { runRest } from "../../rest/rest.js";

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
			let failed = false;
			for (const entry of report.banks) {
				if (entry.error !== undefined) {
					process.stdout.write(`failed ${entry.bank}: ${entry.error}\n`);
					failed = true;
					continue;
				}
				if (entry.consolidation === null) {
					process.stdout.write(`skipped ${entry.bank}: not found\n`);
					continue;
				}
				process.stdout.write(
					`consolidated ${entry.bank}: ${entry.consolidation.deduplicated} deduplicated\n`,
				);
				if (entry.learnings === 0) {
					process.stdout.write(`no memory tagged kind:learning in ${entry.bank}\n`);
					continue;
				}
				for (const proposal of entry.proposals) {
					process.stdout.write(
						`promote ${proposal.id} ${proposal.fromScope} → ${proposal.toScope} (projects: ${proposal.projects.join(", ")})\n`,
					);
				}
				if (entry.proposals.length === 0) {
					process.stdout.write(`nothing to promote in ${entry.bank}\n`);
				} else if (values.apply) {
					for (const id of entry.applied) process.stdout.write(`promoted ${id}\n`);
				}
				// A refused promotion was warned about on stderr; the exit must say it too.
				if (entry.failed.length > 0) failed = true;
			}
			return failed ? 1 : 0;
		} finally {
			state.close();
		}
	} catch (error) {
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return error instanceof ConfigError ? 2 : 1;
	}
}
