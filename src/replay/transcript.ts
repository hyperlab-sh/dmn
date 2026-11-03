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
	/** The assistant text that follows the prompt; set by `orderPrompts`, not `promptsFrom`. */
	answer?: string;
	/** The transcript's basename; set by `orderPrompts`, not `promptsFrom`. */
	file?: string;
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

/** One accepted prompt with the assistant text that follows it, from a single walk. */
interface WalkedPrompt {
	prompt: ReplayPrompt;
	answer: string;
}

/**
 * The prompts of a Claude Code transcript with what the cue needs, each paired with the
 * assistant text that follows it: the recorded cwd, the tools used since the previous prompt,
 * the latest slash command or `Skill` call, and the answer the Stop hook would have retained.
 * A slash command's arguments are its prompt; a bare command, tool results, meta,
 * compact-summary, sidechain and shell lines are not prompts.
 */
function walkPrompts(path: string): WalkedPrompt[] {
	const walked: WalkedPrompt[] = [];
	let current: { prompt: ReplayPrompt; answerParts: string[] } | undefined;
	let recentTools: string[] = [];
	let activeSkill: string | undefined;
	let cwd = "";
	const close = () => {
		if (!current) return;
		walked.push({ prompt: current.prompt, answer: current.answerParts.join("\n\n") });
		current = undefined;
	};
	for (const line of parseLines(path)) {
		// A subagent's thread: its tools and cwd say nothing about the user's next prompt.
		if (line.isSidechain) continue;
		if (typeof line.cwd === "string") cwd = line.cwd;
		const content = line.message?.content;
		if (line.type === "assistant") {
			const found = toolEntries(content);
			recentTools.push(...found.tools);
			if (found.skill) activeSkill = found.skill;
			// What the assistant said after the prompt so far is this prompt's answer, as the
			// Stop hook's `lastTurns` reads it: text blocks only, entries joined by a blank line.
			const said = typedText(content);
			if (current && said.trim()) current.answerParts.push(said);
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
		close();
		current = {
			prompt: {
				index: walked.length,
				text,
				cwd,
				recentTools,
				...(activeSkill ? { activeSkill } : {}),
				at: typeof line.timestamp === "string" ? line.timestamp : "",
			},
			answerParts: [],
		};
		recentTools = [];
	}
	close();
	return walked;
}

/**
 * The user prompts of a Claude Code transcript with what the cue needs: the recorded cwd, the
 * tools used since the previous prompt, and the latest slash command or `Skill` call.
 * See `walkPrompts` for what counts as a prompt.
 */
export function promptsFrom(path: string): ReplayPrompt[] {
	return walkPrompts(path).map(({ prompt }) => prompt);
}

/**
 * The assistant text that follows each prompt of a transcript, by prompt index: what the Stop
 * hook would have retained beside the prompt. Aligned with `promptsFrom` by construction (one
 * walk); entries after a prompt end at the next prompt.
 */
export function answersFrom(path: string): string[] {
	return walkPrompts(path).map(({ answer }) => answer);
}
