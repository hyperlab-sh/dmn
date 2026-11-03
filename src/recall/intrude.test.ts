import { expect, test } from "bun:test";
import { intrusionDraw } from "../activation/random.js";
import type { Cue } from "../cue/cue.js";
import { decideIntrusion, intrusionCue, isEligible } from "./intrude.js";
import type { RankedMemory } from "./rerank.js";

const candidate = (id: string, activation: number): RankedMemory => ({
	id,
	text: id,
	tags: [],
	createdAt: "2026-01-01T00:00:00Z",
	activation,
	baseLevel: activation,
	spreading: 0,
	noise: 0,
});

// Activation equal to the threshold is a probability of exactly 0.5: a draw below it wins.
const config = { intrusionThreshold: 0.5, intrusionCooldown: 3 };
const strong = [candidate("top", 0.5), candidate("second", 0.4)];
const weak = [candidate("weak", -3)];

test("the top candidate surfaces when its probability beats the draw and the cooldown is over", () => {
	const decide = (ranked: RankedMemory[], draw: number, toolCallsSinceLast: number) =>
		decideIntrusion({ ranked, config, random: () => draw, toolCallsSinceLast });
	expect(decide(strong, 0.49, 3)?.id).toBe("top");
	expect(decide(strong, 0.51, 3)).toBeNull();
	expect(decide(weak, 0.49, 3)).toBeNull();
	expect(decide([], 0, 3)).toBeNull();
	expect(decide(strong, 0, 2)).toBeNull();
	expect(decide(strong, 0, Number.POSITIVE_INFINITY)?.id).toBe("top");
	expect(isEligible({ ...config, intrusionThreshold: null }, 99)).toBe(false);
	expect(isEligible(config, 3)).toBe(true);
	expect(isEligible(config, 2)).toBe(false);
});

test("five calls with a cooldown of 3 emit on the first and the fifth only", () => {
	// The draws the hook test pins with DMN_SEED=24 and tool_use_ids tool-1..tool-5:
	// 0.405 0.600 0.473 0.660 0.365. Calls 1 and 5 win at p = 0.5; call 3 would win too if the
	// cooldown did not hold it back.
	const draws = [1, 2, 3, 4, 5].map((call) => intrusionDraw("24", `tool-${call}`));
	expect(draws.map((draw) => draw.toFixed(3))).toEqual([
		"0.405",
		"0.600",
		"0.473",
		"0.660",
		"0.365",
	]);
	let toolCallsSinceLast = Number.POSITIVE_INFINITY;
	const emitted: boolean[] = [];
	for (const draw of draws) {
		const memory = decideIntrusion({
			ranked: strong,
			config,
			random: () => draw,
			toolCallsSinceLast,
		});
		emitted.push(memory !== null);
		toolCallsSinceLast = memory ? 0 : toolCallsSinceLast + 1;
	}
	expect(emitted).toEqual([true, false, false, false, true]);
});

const cue: Cue = {
	organization: "acme",
	project: "space",
	stack: ["ts"],
	role: "developer",
	task: "unknown",
};

test("the query holds the tool's target words and the session cue's phrase", () => {
	const phrase = "developer working on space (ts), task:";
	const read = intrusionCue(cue, "Read", { file_path: "/repo/src/syncWorker/retry-delay.ts" });
	expect(read.query).toBe(`retry delay syncWorker ${phrase} read`);
	expect(read.cue.task).toBe("read");

	const edit = intrusionCue(cue, "Edit", { file_path: "/repo/src/worker.ts" });
	expect(edit.query).toStartWith("worker src ");
	expect(edit.cue.task).toBe("edit");

	const bash = intrusionCue(cue, "Bash", { command: "bun test src/worker.test.ts --bail" });
	expect(bash.query).toStartWith("bun test ");
	expect(bash.cue.task).toBe("test");

	// Only the command name and a letters-only subcommand reach the query, never an argument.
	const secret = intrusionCue(cue, "Bash", { command: "echo sk-abc123" });
	expect(secret.query).toStartWith("echo ");
	expect(secret.query).not.toContain("sk-");
	expect(
		intrusionCue(cue, "Bash", { command: "curl -H Authorization:sk-123 x" }).query,
	).toStartWith("curl developer");
	expect(intrusionCue(cue, "Bash", { command: "API_KEY=abc run" }).query).toBe(`${phrase} unknown`);

	const other = intrusionCue(cue, "WebSearch", { query: "anything" });
	expect(other).toEqual({ cue, query: `${phrase} unknown` });
	expect(intrusionCue(cue, "Read", undefined).query).toBe(`${phrase} unknown`);
});
