import { expect, test } from "bun:test";
import { promptsFrom } from "./transcript.js";

const fixture = (name: string) =>
	new URL(`../../fixtures/replay/${name}`, import.meta.url).pathname;

test("session A: cwd, tools since the previous prompt, and the slash-command skill", () => {
	const prompts = promptsFrom(fixture("session-a.jsonl"));
	// The tool result, the torn line and the <command-name> line are not prompts.
	expect(prompts.map((prompt) => prompt.text)).toEqual([
		"How do I run the tests for the widgets package?",
		"Fix the failing parser test",
		"Review the diff for the retry logic",
	]);
	expect(prompts.map((prompt) => prompt.index)).toEqual([0, 1, 2]);
	expect(prompts.every((prompt) => prompt.cwd === "/home/dev/acme/widgets")).toBe(true);
	expect(prompts[0]?.at).toBe("2026-06-01T09:00:00.000Z");
	expect(prompts[0]?.recentTools).toEqual([]);
	expect(prompts[0]?.activeSkill).toBeUndefined();
	// A Bash command naming tests keeps only the marker, never the command.
	expect(prompts[1]?.recentTools).toEqual(["Read", "Grep", "Edit", "Bash:test"]);
	expect(prompts[1]?.activeSkill).toBeUndefined();
	// Tools reset at each prompt; the skill stays until replaced.
	expect(prompts[2]?.recentTools).toEqual(["Read"]);
	expect(prompts[2]?.activeSkill).toBe("code-review");
});

test("session B: text blocks, meta lines skipped, skill from a Skill tool call", () => {
	const prompts = promptsFrom(fixture("session-b.jsonl"));
	expect(prompts.map((prompt) => prompt.text)).toEqual([
		"What is the state of the retry module?",
		"Plan the migration of the retry module into units\nthat can land separately",
		"Cap the retry delay in the module",
		"fix the retry parser",
	]);
	expect(prompts[0]?.activeSkill).toBeUndefined();
	expect(prompts[1]?.activeSkill).toBe("plan");
	expect(prompts[1]?.recentTools).toEqual(["Skill", "Read"]);
	expect(prompts[2]?.recentTools).toEqual(["Edit", "Edit"]);
	// Compact summary, sidechain, shell and interrupt lines left prompt 3's tools intact.
	expect(prompts[3]?.activeSkill).toBe("unit");
	expect(prompts[3]?.recentTools).toEqual([]);
	expect(prompts[2]?.cwd).toBe("/home/dev/acme/widgets/services");
});
