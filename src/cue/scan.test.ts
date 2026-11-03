import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCue, type CueInput } from "./cue.js";
import { scanCueInput } from "./scan.js";

const space = join(import.meta.dir, "../../fixtures/cue/space-a");
const cwd = join(space, "services/widgets");
let input: CueInput;

beforeAll(() => {
	input = scanCueInput({
		cwd,
		transcriptPath: join(space, "transcript.jsonl"),
		organizations: { "space-a": "acme" },
	});
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
	expect(input.recentTools).toEqual(["Read", "Grep", "Skill", "Edit", "Bash:bun test src"]);
});

test("scanned input builds the expected cue", () => {
	expect(buildCue(input)).toEqual({
		organization: "acme",
		project: "space-a",
		stack: ["bun", "rust", "typescript"],
		role: "architect",
		task: "test",
	});
});
