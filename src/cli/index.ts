#!/usr/bin/env node
const usage = `dmn — Default Mode Network

Usage:
  dmn --version
  dmn help

Nothing else yet. See https://github.com/hyperlab-sh/dmn for the roadmap.
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
	default:
		process.stderr.write(`dmn: unknown command "${command}"\n\n${usage}`);
		process.exit(1);
}
