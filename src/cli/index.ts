#!/usr/bin/env node
import { ConfigError, loadConfig } from "../config/config.js";

const usage = `dmn — Default Mode Network

Usage:
  dmn --version
  dmn help
  dmn replay <transcript.jsonl>... | dmn replay score <run-dir>

See https://github.com/hyperlab-sh/dmn for the roadmap.
`;

const [command = "help"] = process.argv.slice(2);

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
		try {
			loadConfig({ env: process.env });
		} catch (error) {
			if (error instanceof ConfigError) {
				process.stderr.write(`dmn: ${error.message}\n`);
				process.exit(2);
			}
			throw error;
		}
		process.stderr.write("dmn: hook commands are not implemented yet\n");
		process.exit(1);
		break;
	default:
		process.stderr.write(`dmn: unknown command "${command}"\n\n${usage}`);
		process.exit(1);
}
