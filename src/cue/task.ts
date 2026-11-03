export type Task = "edit" | "read" | "test" | "review" | "plan" | "unknown";

const editTools = new Set(["Edit", "Write", "MultiEdit"]);
const readTools = new Set(["Read", "Grep", "Glob"]);

/** Tool name of a `recentTools` entry; entries are `Name` or `Name:input`. */
function toolName(entry: string): string {
	const colon = entry.indexOf(":");
	return colon === -1 ? entry : entry.slice(0, colon);
}

export function hasEdit(recentTools: string[]): boolean {
	return recentTools.some((entry) => editTools.has(toolName(entry)));
}

/** Task from the recent tool mix: a test command wins, else the strict majority kind. */
export function detectTask(recentTools: string[]): Task {
	if (recentTools.length === 0) return "unknown";
	if (recentTools.some((entry) => toolName(entry) === "Bash" && /test/i.test(entry.slice(5)))) {
		return "test";
	}
	const names = recentTools.map(toolName);
	const half = recentTools.length / 2;
	if (names.filter((name) => editTools.has(name)).length > half) return "edit";
	if (names.filter((name) => readTools.has(name)).length > half) return "read";
	return "unknown";
}
