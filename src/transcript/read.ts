import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type TranscriptEntry = {
	/** Byte offset of the line in the file: stable, and unique within it. */
	offset: number;
	role?: "user" | "assistant";
	uuid?: string;
	/** Claude Code marks injected context (not typed by the user) with `isMeta`. */
	meta: boolean;
	content: unknown;
};

export type LastTurns = {
	user: string;
	assistant: string;
	/** The user entry's uuid, or `[<namespace>:]offset-<n>` when it has none: one id per exchange. */
	turnId: string;
};

/** Parses one transcript line; undefined for blank, malformed or message-less lines. */
export function parseTranscriptLine(text: string, offset: number): TranscriptEntry | undefined {
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
		offset,
		role,
		...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
		meta: raw.isMeta === true,
		content: raw.message.content,
	};
}

const firstChunk = 64 * 1024;

/**
 * Entries from the end of the file, reading backwards in growing chunks until `enough` accepts
 * them or the file starts. A chunk that starts mid-line drops that partial line.
 */
function readBackwards(
	path: string,
	enough: (entries: TranscriptEntry[]) => boolean,
): TranscriptEntry[] {
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const size = fstatSync(descriptor).size;
		for (let length = firstChunk; ; length *= 2) {
			const start = Math.max(0, size - length);
			const buffer = Buffer.alloc(size - start);
			readSync(descriptor, buffer, 0, buffer.length, start);
			const entries: TranscriptEntry[] = [];
			let lineStart = 0;
			if (start > 0) {
				const newline = buffer.indexOf(10);
				if (newline === -1) {
					if (length >= size) return [];
					continue;
				}
				lineStart = newline + 1;
			}
			while (lineStart <= buffer.length) {
				let lineEnd = buffer.indexOf(10, lineStart);
				if (lineEnd === -1) lineEnd = buffer.length;
				const entry = parseTranscriptLine(
					buffer.toString("utf8", lineStart, lineEnd),
					start + lineStart,
				);
				if (entry) entries.push(entry);
				lineStart = lineEnd + 1;
			}
			if (start === 0 || enough(entries)) return entries;
		}
	} finally {
		closeSync(descriptor);
	}
}

/** The last `count` parseable entries, oldest first. A missing file reads as empty. */
export function readTranscriptTail(path: string, count: number): TranscriptEntry[] {
	if (count <= 0) return [];
	return readBackwards(path, (entries) => entries.length >= count).slice(-count);
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

/** Command output and interruption notices are written as user entries but are not prompts. */
const notPrompt = /^\s*(?:<local-command-|\[Request interrupted)/;

function isPrompt(entry: TranscriptEntry): boolean {
	if (entry.role !== "user" || entry.meta) return false;
	const text = entryText(entry);
	return text.trim() !== "" && !notPrompt.test(text);
}

/**
 * The last prompt the user typed and everything the assistant said after it.
 * Tool results, injected context, command output and interruptions do not start a turn.
 * `namespace` (the session id) prefixes the fallback id so sessions never share one.
 * Null when the transcript holds no user prompt.
 */
export function lastTurns(path: string, namespace?: string): LastTurns | null {
	const entries = readBackwards(path, (found) => found.some(isPrompt));
	let start = entries.length - 1;
	while (start >= 0 && !isPrompt(entries[start] as TranscriptEntry)) start--;
	const prompt = entries[start];
	if (!prompt) return null;
	const assistant = entries
		.slice(start + 1)
		.filter((entry) => entry.role === "assistant")
		.map(entryText)
		.filter((text) => text.trim())
		.join("\n\n");
	const fallback = `${namespace ? `${namespace}:` : ""}offset-${prompt.offset}`;
	return { user: entryText(prompt), assistant, turnId: prompt.uuid ?? fallback };
}
