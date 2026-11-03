import { describe, expect, test } from "bun:test";
import { detectTask } from "./task.js";

describe("detectTask", () => {
	const rows: [string, string[], string][] = [
		["edit majority", ["Edit", "Write", "Read"], "edit"],
		["MultiEdit counts as edit", ["MultiEdit", "MultiEdit", "Read"], "edit"],
		["read majority", ["Read", "Grep", "Glob", "Edit"], "read"],
		["bash test wins over majority", ["Edit", "Edit", "Edit", "Bash:bun test src"], "test"],
		["bash without test", ["Bash:ls", "Bash:git status"], "unknown"],
		["no majority", ["Edit", "Read"], "unknown"],
		["empty", [], "unknown"],
	];
	test.each(rows)("%s", (_name, tools, expected) => {
		expect(detectTask(tools)).toBe(expected as ReturnType<typeof detectTask>);
	});
});
