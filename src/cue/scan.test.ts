import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCue, type CueInput } from "./cue.js";
import { scanCueInput } from "./scan.js";

const space = join(import.meta.dir, "../../fixtures/cue/acme/space-a");
const cwd = join(space, "services/widgets");
const organizations = { acme: "acme" };
let input: CueInput;
let scratch: string;

const toolUse = (name: string, input: object) =>
	JSON.stringify({ message: { content: [{ type: "tool_use", name, input }] } });

const scanTranscript = (lines: string[], file: string): CueInput => {
	const transcriptPath = join(scratch, file);
	writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
	return scanCueInput({ cwd, transcriptPath, organizations });
};

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dmn-cue-"));
	input = scanCueInput({ cwd, transcriptPath: join(space, "transcript.jsonl"), organizations });
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

test("finds the space root, no origin outside a repository", () => {
	expect(input.spaceRoot).toBe(space);
	expect(input.originUrl).toBeUndefined();
});

test("reads manifests from cwd and the space root only", () => {
	expect(input.manifests.map((manifest) => manifest.path.slice(space.length + 1)).sort()).toEqual([
		"package.json",
		"services/widgets/Cargo.toml",
		"tsconfig.json",
	]);
});

test("reads the active skill and tools from the transcript tail", () => {
	expect(input.activeSkill).toBe("plan");
	expect(input.recentTools).toEqual(["Read", "Grep", "Skill", "Edit", "Bash:test"]);
});

test("organization and project come from the scanned space root", () => {
	const cue = buildCue(input);
	expect([cue.organization, cue.project]).toEqual(["acme", "space-a"]);
});

test("Bash command text never reaches recentTools", () => {
	const result = scanTranscript(
		[
			toolUse("Bash", { command: "curl -H 'Authorization: Bearer TOKEN=abc' x" }),
			toolUse("Bash", { command: "bun test" }),
		],
		"secret.jsonl",
	);
	expect(result.recentTools).toEqual(["Bash", "Bash:test"]);
});

test("slash commands typed by the user set the active skill", () => {
	const typed = JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: "<command-message>ship</command-message>\n<command-name>/ship</command-name>",
		},
	});
	const blocks = JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "text", text: "<command-name>/land</command-name>" }],
		},
	});
	expect(scanTranscript([typed], "typed.jsonl").activeSkill).toBe("ship");
	expect(scanTranscript([blocks], "blocks.jsonl").activeSkill).toBe("land");
});

test("a slash command quoted in a tool result is not an active skill", () => {
	const quoted = JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", content: "<command-name>/ship</command-name>" }],
		},
	});
	expect(scanTranscript([quoted], "quoted.jsonl").activeSkill).toBeUndefined();
});

test("only the last 50 transcript lines are read", () => {
	const lines = [
		...Array.from({ length: 10 }, () => toolUse("Skill", { skill: "code-review" })),
		...Array.from({ length: 50 }, () => toolUse("Read", { padding: "x".repeat(8 * 1024) })),
	];
	const result = scanTranscript(lines, "long.jsonl");
	expect(result.activeSkill).toBeUndefined();
	expect(result.recentTools).toHaveLength(50);
});
