export type Turn = {
	role: "user" | "assistant";
	text: string;
};

export type RetainVerdict = { retain: true } | { retain: false; reason: string };

const secretPatterns: RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** `KEY=value` with a sensitive word in the name, at the start of a line. */
const envAssignment =
	/^\s*(?:export\s+)?[A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Za-z0-9_]*\s*=\s*\S/im;

const crossSession = /<channel[\s>]|\bmessage from session\b/i;
const orchestration =
	/<(?:orca|herdr)[\s>-]|^\s*\[(?:orca|herdr)[\]:\s]|\b(?:orca|herdr)-(?:message|dispatch)\b|<task-notification>/im;
const systemReminder = /<system-reminder>|<\/system-reminder>/i;
const fileBlock = /<(?:file|document)[\s>]/i;
const pathLine = /^[\w@~.-]*[\\/][\w@~./\\-]+$|^[\w.-]+\.[A-Za-z0-9]{1,8}$/;

const minimumListedLines = 10;
const minimumPathShare = 0.6;

/** A wall of file paths or file blocks with no question asked of anyone. */
function isFileIndexing(text: string): boolean {
	if (text.includes("?")) return false;
	if (fileBlock.test(text)) return true;
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < minimumListedLines) return false;
	const paths = lines.filter((line) => pathLine.test(line)).length;
	return paths / lines.length >= minimumPathShare;
}

/** Decides whether a turn may become a memory. Protocol traffic and secrets never do. */
export function shouldRetain(turn: Turn): RetainVerdict {
	const { text } = turn;
	if (!text.trim()) return { retain: false, reason: "empty" };
	// Secrets first: a turn that holds one is dropped whatever else it is.
	if (secretPatterns.some((pattern) => pattern.test(text))) {
		return { retain: false, reason: "secret" };
	}
	if (envAssignment.test(text)) return { retain: false, reason: "env-assignment" };
	if (systemReminder.test(text)) return { retain: false, reason: "system-reminder" };
	if (crossSession.test(text)) return { retain: false, reason: "cross-session-message" };
	if (orchestration.test(text)) return { retain: false, reason: "orchestration-message" };
	if (isFileIndexing(text)) return { retain: false, reason: "file-indexing" };
	return { retain: true };
}
