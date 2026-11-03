import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CueInput } from "./cue.js";
import { type Manifest, manifestExtensions, manifestFileNames } from "./stack.js";

export type ScanOptions = {
	cwd: string;
	transcriptPath?: string;
	organizations: Record<string, string>;
};

const transcriptTailLines = 50;

/** Nearest ancestor of `start` (inclusive) for which `marker` exists, stopping at `limit`. */
function findUp(start: string, marker: string, limit?: string): string | undefined {
	let directory = resolve(start);
	for (;;) {
		if (existsSync(join(directory, marker))) return directory;
		if (directory === limit) return undefined;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function readOrigin(repositoryRoot: string): string | undefined {
	try {
		const result = Bun.spawnSync([
			"git",
			"-C",
			repositoryRoot,
			"config",
			"--get",
			"remote.origin.url",
		]);
		if (result.exitCode !== 0) return undefined;
		return result.stdout.toString().trim() || undefined;
	} catch {
		return undefined;
	}
}

function readManifests(directories: string[]): Manifest[] {
	const manifests: Manifest[] = [];
	for (const directory of directories) {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(directory, name);
			if ((manifestFileNames as readonly string[]).includes(name)) {
				try {
					manifests.push({ path, content: readFileSync(path, "utf8") });
				} catch {
					// Unreadable manifest: ignore.
				}
			} else if (manifestExtensions.some((extension) => name.endsWith(extension))) {
				manifests.push({ path, content: "" });
			}
		}
	}
	return manifests;
}

type TranscriptFacts = { activeSkill?: string; recentTools: string[] };

function readTranscript(transcriptPath: string | undefined): TranscriptFacts {
	const facts: TranscriptFacts = { recentTools: [] };
	if (!transcriptPath) return facts;
	let lines: string[];
	try {
		lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
	} catch {
		return facts;
	}
	for (const line of lines.slice(-transcriptTailLines)) {
		const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(line);
		if (command?.[1]) facts.activeSkill = command[1];
		let entry: { message?: { content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
			const input = block.input ?? {};
			if (block.name === "Skill" && typeof input.skill === "string")
				facts.activeSkill = input.skill;
			const detail =
				block.name === "Bash" && typeof input.command === "string" ? `:${input.command}` : "";
			facts.recentTools.push(`${block.name}${detail}`);
		}
	}
	return facts;
}

/** Reads the session's raw facts from disk, git and the transcript tail. */
export function scanCueInput(options: ScanOptions): CueInput {
	const cwd = resolve(options.cwd);
	const spaceRoot = findUp(cwd, "HYPER.md");
	const repositoryRoot = findUp(cwd, ".git", spaceRoot);
	const originUrl = repositoryRoot ? readOrigin(repositoryRoot) : undefined;
	const directories = [...new Set([cwd, repositoryRoot ?? spaceRoot ?? cwd])];
	const { activeSkill, recentTools } = readTranscript(options.transcriptPath);
	return {
		cwd,
		...(spaceRoot ? { spaceRoot } : {}),
		...(originUrl ? { originUrl } : {}),
		manifests: readManifests(directories),
		...(activeSkill ? { activeSkill } : {}),
		recentTools,
		organizations: options.organizations,
	};
}
