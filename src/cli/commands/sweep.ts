import { parseArgs } from "node:util";
import { ConfigError, createStore, loadConfig, openState } from "../../config/config.js";
import { bankFor } from "../../store/hindsight.js";
import { sweep } from "../../sweep/sweep.js";

/** Runs `dmn sweep [--bank <b>...] [--dry-run]` or `dmn sweep --revive <id>`; returns the exit code. */
export async function runSweep(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<number> {
	let values: { bank?: string[]; "dry-run"?: boolean; revive?: string };
	try {
		({ values } = parseArgs({
			args,
			options: {
				bank: { type: "string", multiple: true },
				"dry-run": { type: "boolean" },
				revive: { type: "string" },
			},
			strict: true,
		}));
	} catch (error) {
		process.stderr.write(`dmn: sweep: ${(error as Error).message}\n`);
		return 1;
	}
	try {
		const config = loadConfig({ env });
		// DMN_NOW (ISO date) is for tests, as in `dmn hook`.
		const now = env.DMN_NOW ? new Date(env.DMN_NOW) : new Date();
		if (Number.isNaN(now.getTime())) throw new Error("DMN_NOW is not an ISO date");
		const state = await openState(config, () => now);
		try {
			if (values.revive !== undefined) {
				if (!state.isDormant(values.revive)) {
					process.stderr.write(`dmn: ${values.revive} is not dormant\n`);
					return 1;
				}
				state.revive(values.revive);
				process.stdout.write(`revived ${values.revive}\n`);
				return 0;
			}
			const banks = values.bank ?? [
				...new Set(
					[undefined, ...Object.values(config.organizations)].map((organization) =>
						bankFor(organization),
					),
				),
			];
			const result = await sweep({
				store: createStore(config),
				state,
				config,
				banks,
				now,
				dryRun: values["dry-run"] === true,
			});
			const verb = values["dry-run"] ? "would mark" : "marked";
			process.stdout.write(
				`examined ${result.examined}; ${verb} ${result.dormant.length} dormant; kept ${result.protectedKept.length} protected\n`,
			);
			for (const id of result.dormant) process.stdout.write(`dormant ${id}\n`);
			for (const id of result.protectedKept) process.stdout.write(`protected ${id}\n`);
			return 0;
		} finally {
			state.close();
		}
	} catch (error) {
		process.stderr.write(`dmn: ${(error as Error).message}\n`);
		return error instanceof ConfigError ? 2 : 1;
	}
}
