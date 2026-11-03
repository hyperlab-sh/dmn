import { readFileSync } from "node:fs";

export interface ReplayPrompt {
	/** Zero-based position among the prompts of one transcript. */
	index: number;
	text: string;
	cwd: string;
	/** `Name` or `Name:test` entries from the tool calls since the previous prompt. */
	recentTools: string[];
	activeSkill?: string | undefined;
	/** Timestamp of the prompt line, or an empty string when it has none. */
	at: string;
}

interface Line {
	type?: string;
	cwd?: string;
	timestamp?: string;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	isSidechain?: boolean;
	message?: { role?: string; content?: unknown };
}

const argumentsPattern = /<command-args>([\s\S]*?)<\/command-args>/;
/** Shell escapes (`!`), local command output and interrupt markers are not prompts. */
const ignoredPrefixes = [
	"<local-command",
	"<bash-input>",
	"<bash-stdout>",
	"<bash-stderr>",
	"[Request interrupted",
];
const commandPattern = /<command-name>\/?([^<\s]+)<\/command-name>/;

function parseLines(path: string): Line[] {
	const lines: Line[] = [];
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		if (!raw.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object") lines.push(parsed as Line);
		} catch {
			// A torn or foreign line is skipped, as in a live transcript.
		}
	}
	return lines;
}

/** The typed text of a user line: a string, or the text blocks of a block list. */
function typedText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function toolEntries(content: unknown): { tools: string[]; skill?: string } {
	const tools: string[] = [];
	let skill: string | undefined;
	if (!Array.isArray(content)) return { tools };
	for (const block of content) {
		if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
		const input = block.input ?? {};
		if (block.name === "Skill" && typeof input.skill === "string") skill = input.skill;
		// Only whether a command mentions "test" is kept: commands may carry secrets.
		const detail =
			block.name === "Bash" && typeof input.command === "string" && /test/i.test(input.command)
				? ":test"
				: "";
		tools.push(`${block.name}${detail}`);
	}
	return skill === undefined ? { tools } : { tools, skill };
}

/**
 * The user prompts of a Claude Code transcript with what the cue needs: the recorded cwd, the
 * tools used since the previous prompt, and the latest slash command or `Skill` call.
 * A slash command's arguments are its prompt; a bare command, tool results, meta, compact-summary,
 * sidechain and shell lines are not prompts.
 */
export function promptsFrom(path: string): ReplayPrompt[] {
	const prompts: ReplayPrompt[] = [];
	let recentTools: string[] = [];
	let activeSkill: string | undefined;
	let cwd = "";
	for (const line of parseLines(path)) {
		// A subagent's thread: its tools and cwd say nothing about the user's next prompt.
		if (line.isSidechain) continue;
		if (typeof line.cwd === "string") cwd = line.cwd;
		const content = line.message?.content;
		if (line.type === "assistant") {
			const found = toolEntries(content);
			recentTools.push(...found.tools);
			if (found.skill) activeSkill = found.skill;
			continue;
		}
		if (line.type !== "user" || line.isMeta) continue;
		if (line.isCompactSummary) continue;
		let text = typedText(content);
		const command = commandPattern.exec(text);
		if (command?.[1]) {
			activeSkill = command[1];
			// What the user typed after the command is the prompt; a bare command is not one.
			text = argumentsPattern.exec(text)?.[1]?.trim() ?? "";
		}
		if (!text.trim() || ignoredPrefixes.some((prefix) => text.trimStart().startsWith(prefix))) {
			continue;
		}
		prompts.push({
			index: prompts.length,
			text,
			cwd,
			recentTools,
			...(activeSkill ? { activeSkill } : {}),
			at: typeof line.timestamp === "string" ? line.timestamp : "",
		});
		recentTools = [];
	}
	return prompts;
}
