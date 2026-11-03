#!/usr/bin/env bun
import { runHook } from "./commands/hook.js";
import { runInstall } from "./commands/install.js";

const usage = `dmn — Default Mode Network

Usage:
  dmn --version
  dmn install [--settings <path>]   add the Claude Code hooks (default ~/.claude/settings.json)
  dmn hook <session-start|user-prompt|post-tool|stop>   run by Claude Code, reads the event on stdin
  dmn sweep [--bank <b>...] [--dry-run]   mark unused, unprotected memories dormant
  dmn sweep --revive <id>   clear a memory's dormancy
  dmn help
  dmn replay <transcript.jsonl>... | dmn replay score <run-dir> | dmn replay judge <run-dir>

See https://github.com/hyperlab-sh/dmn for the roadmap.
`;

const [command = "help", ...rest] = process.argv.slice(2);

switch (command) {
	case "--version":
	case "-v":
	case "version":
		console.log(__DMN_VERSION__);
		break;
	case "help":
	case "--help":
	case "-h":
		process.stdout.write(usage);
		break;
	case "replay":
		process.exitCode = await (await import("./commands/replay.js")).run(process.argv.slice(3));
		break;
	case "hook":
		process.exitCode = await runHook(rest[0], process.env);
		break;
	case "sweep":
		process.exitCode = await (await import("./commands/sweep.js")).runSweep(rest, process.env);
		break;
	case "install":
		process.exitCode = runInstall(rest, process.env);
		break;
	default:
		process.stderr.write(`dmn: unknown command "${command}"\n\n${usage}`);
		process.exit(1);
}
