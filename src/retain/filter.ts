export type Turn = {
	role: "user" | "assistant";
	text: string;
};

export type RetainVerdict = { retain: true } | { retain: false; reason: string };

const secretPatterns: RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\bglpat-[A-Za-z0-9_-]{20,}/,
	/\bnpm_[A-Za-z0-9]{36}\b/,
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
	/\b[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9+/=][A-Za-z0-9+/=]*[A-Z0-9+/=])[A-Za-z0-9+/=]{16,}/,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bAIza[0-9A-Za-z_-]{35}\b/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	// A password in a URL: scheme://user:password@host
	/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** `KEY=value` with a sensitive word in the name, at the start of a line. */
const envAssignment =
	/^\s*(?:export\s+)?[A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Za-z0-9_]*\s*=\s*\S/im;
/** `password: hunter2`, `"api_key": "..."`, `client_secret = ...`: dotenv, YAML and JSON forms. */
const credentialAssignment =
	/["']?[A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?(?!(?:string|number|boolean|unknown|any|null|undefined|optional|required)(?![\w.-]))[^\s"',]{6,}/i;

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

/** Whether `text` holds a secret or a credential assignment. */
export function containsSecret(text: string): boolean {
	return (
		secretPatterns.some((pattern) => pattern.test(text)) ||
		envAssignment.test(text) ||
		credentialAssignment.test(text)
	);
}

/** Decides whether a turn may become a memory. Protocol traffic and secrets never do. */
export function shouldRetain(turn: Turn): RetainVerdict {
	const { text } = turn;
	if (!text.trim()) return { retain: false, reason: "empty" };
	// Secrets first: a turn that holds one is dropped whatever else it is.
	if (secretPatterns.some((pattern) => pattern.test(text))) {
		return { retain: false, reason: "secret" };
	}
	if (envAssignment.test(text) || credentialAssignment.test(text)) {
		return { retain: false, reason: "credential-assignment" };
	}
	if (systemReminder.test(text)) return { retain: false, reason: "system-reminder" };
	if (crossSession.test(text)) return { retain: false, reason: "cross-session-message" };
	if (orchestration.test(text)) return { retain: false, reason: "orchestration-message" };
	if (isFileIndexing(text)) return { retain: false, reason: "file-indexing" };
	return { retain: true };
}
