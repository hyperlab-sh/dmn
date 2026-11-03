import { readFileSync } from "node:fs";

export type TranscriptEntry = {
	/** Zero-based line number in the file. */
	line: number;
	role?: "user" | "assistant";
	uuid?: string;
	/** Claude Code marks injected context (not typed by the user) with `isMeta`. */
	meta: boolean;
	content: unknown;
};

export type LastTurns = {
	user: string;
	assistant: string;
	/** The user entry's uuid, or `line-<n>` when it has none: one id per exchange. */
	turnId: string;
};

/** Parses one transcript line; undefined for blank, malformed or message-less lines. */
export function parseTranscriptLine(text: string, line: number): TranscriptEntry | undefined {
	if (!text.trim()) return undefined;
	let raw: {
		type?: unknown;
		uuid?: unknown;
		isMeta?: unknown;
		isSidechain?: unknown;
		message?: { role?: unknown; content?: unknown };
	};
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || raw.isSidechain === true) return undefined;
	const role = raw.message?.role ?? raw.type;
	if (role !== "user" && role !== "assistant") return undefined;
	if (raw.message === undefined) return undefined;
	return {
		line,
		role,
		...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
		meta: raw.isMeta === true,
		content: raw.message.content,
	};
}

function readEntries(path: string): TranscriptEntry[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: TranscriptEntry[] = [];
	for (const [line, content] of text.split("\n").entries()) {
		const entry = parseTranscriptLine(content, line);
		if (entry) entries.push(entry);
	}
	return entries;
}

/** The last `count` parseable entries, oldest first. A missing file reads as empty. */
export function readTranscriptTail(path: string, count: number): TranscriptEntry[] {
	return count <= 0 ? [] : readEntries(path).slice(-count);
}

/** The text blocks of an entry (or its string content), joined by newlines. */
export function entryText(entry: TranscriptEntry): string {
	const { content } = entry;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block?.type === "text" && typeof block.text === "string" ? block.text : undefined,
		)
		.filter((text): text is string => text !== undefined)
		.join("\n");
}

/**
 * The last prompt the user typed and everything the assistant said after it.
 * Tool results (user entries without text) and injected context do not start a turn.
 * Null when the transcript holds no user prompt.
 */
export function lastTurns(path: string): LastTurns | null {
	const entries = readEntries(path);
	let start = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.role === "user" && !entry.meta && entryText(entry).trim()) {
			start = index;
			break;
		}
	}
	const prompt = entries[start];
	if (!prompt) return null;
	const assistant = entries
		.slice(start + 1)
		.filter((entry) => entry.role === "assistant")
		.map(entryText)
		.filter((text) => text.trim())
		.join("\n\n");
	return {
		user: entryText(prompt),
		assistant,
		turnId: prompt.uuid ?? `line-${prompt.line}`,
	};
}
