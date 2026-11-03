import { expect, test } from "bun:test";
import { seededRandom } from "../cli/commands/hook.js";
import type { Cue } from "../cue/cue.js";
import { decideIntrusion, intrusionCue } from "./intrude.js";
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

// Activation 1.5 against threshold 0.5 is a probability of about 0.98: only a draw above it loses.
const config = { intrusionThreshold: 0.5, intrusionCooldown: 3 };
const strong = [candidate("top", 1.5), candidate("second", 1.4)];
const weak = [candidate("weak", -3)];

test("the top candidate surfaces when its probability beats the draw and the cooldown is over", () => {
	const decide = (ranked: RankedMemory[], draw: number, toolCallsSinceLast: number, cooldown = 3) =>
		decideIntrusion({
			ranked,
			config: { ...config, intrusionCooldown: cooldown },
			random: () => draw,
			toolCallsSinceLast,
		});
	expect(decide(strong, 0.5, 3)?.id).toBe("top");
	expect(decide(strong, 0.999, 3)).toBeNull();
	expect(decide(weak, 0.5, 3)).toBeNull();
	expect(decide([], 0, 3)).toBeNull();
	expect(decide(strong, 0, 2)).toBeNull();
	expect(decide(strong, 0, Number.POSITIVE_INFINITY)?.id).toBe("top");
	expect(
		decideIntrusion({
			ranked: strong,
			config: { ...config, intrusionThreshold: null },
			random: () => 0,
			toolCallsSinceLast: 99,
		}),
	).toBeNull();
});

test("five calls with a cooldown of 3 emit on the first and the fifth only", () => {
	// The generator the hook test pins with DMN_SEED: its first draw is 0.304, which wins.
	const random = seededRandom("11");
	let toolCallsSinceLast = Number.POSITIVE_INFINITY;
	const emitted: boolean[] = [];
	for (let call = 1; call <= 5; call++) {
		const memory = decideIntrusion({ ranked: strong, config, random, toolCallsSinceLast });
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

	// A command word that could carry a secret never reaches the query.
	const secret = intrusionCue(cue, "Bash", { command: "curl -H Authorization:sk-123 x" });
	expect(secret.query).toBe(`curl ${phrase} unknown`);
	expect(intrusionCue(cue, "Bash", { command: "API_KEY=abc run" }).query).toBe(`${phrase} unknown`);

	const other = intrusionCue(cue, "WebSearch", { query: "anything" });
	expect(other).toEqual({ cue, query: `${phrase} unknown` });
	expect(intrusionCue(cue, "Read", undefined).query).toBe(`${phrase} unknown`);
});
