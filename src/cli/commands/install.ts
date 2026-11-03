import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addDmnHooks, type ClaudeSettings, SettingsError } from "../../hooks/settings.js";

function readSettings(path: string): ClaudeSettings {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SettingsError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SettingsError(`${path} does not hold a JSON object`);
	}
	return parsed as ClaudeSettings;
}

/** Runs `dmn install [--settings <path>]`; returns the exit code. */
export function runInstall(args: string[], env: Record<string, string | undefined>): number {
	let path = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "settings.json");
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--settings" && args[index + 1]) {
			path = args[++index] as string;
		} else {
			process.stderr.write(`dmn: install: unexpected argument "${args[index]}"\n`);
			return 1;
		}
	}
	try {
		const before = readSettings(path);
		const after = addDmnHooks(before);
		if (JSON.stringify(before) === JSON.stringify(after)) {
			process.stdout.write(`dmn: hooks already installed in ${path}\n`);
			return 0;
		}
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.dmn-${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(after, null, 2)}\n`);
		renameSync(temporary, path);
		process.stdout.write(`dmn: hooks installed in ${path}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`dmn: install failed: ${(error as Error).message}\n`);
		return 1;
	}
}
