import { describe, expect, test } from "bun:test";
import {
	activation,
	baseLevelActivation,
	defaultActivationParameters,
	logisticNoise,
	retrievalProbability,
	spreadingActivation,
} from "./act-r.js";

const fixedRandom = () => 0.5;

describe("baseLevelActivation", () => {
	test("matches the optimized-learning formula", () => {
		// ln(4 / 0.5) - 0.5 * ln(100)
		expect(baseLevelActivation(4, 100)).toBeCloseTo(Math.log(8) - 0.5 * Math.log(100), 10);
	});

	test("rises with use and falls with age", () => {
		expect(baseLevelActivation(5, 48)).toBeGreaterThan(baseLevelActivation(1, 48));
		expect(baseLevelActivation(3, 1)).toBeGreaterThan(baseLevelActivation(3, 24 * 30));
	});

	test("a memory that was created but never used still has finite activation", () => {
		expect(Number.isFinite(baseLevelActivation(0, 0))).toBe(true);
		expect(baseLevelActivation(0, 0)).toBe(baseLevelActivation(1, 1 / 60));
	});

	test("a repeated memory from months ago can outrank a fresh one-off", () => {
		expect(baseLevelActivation(40, 24 * 90)).toBeGreaterThan(baseLevelActivation(1, 24));
	});
});

describe("spreadingActivation", () => {
	test("is zero with no shared cues", () => {
		expect(spreadingActivation([])).toBe(0);
	});

	test("a cue linked to one memory spreads the maximum", () => {
		expect(spreadingActivation([{ fan: 1 }])).toBeCloseTo(1.6, 10);
	});

	test("the fan effect: a cue shared by everything spreads nothing", () => {
		expect(spreadingActivation([{ fan: 10_000 }])).toBe(0);
		expect(spreadingActivation([{ fan: 5 }])).toBeLessThan(spreadingActivation([{ fan: 2 }]));
	});

	test("weights default to 1 / number of cues", () => {
		const two = spreadingActivation([{ fan: 1 }, { fan: 1 }]);
		expect(two).toBeCloseTo(1.6, 10);
	});

	test("explicit weights are honoured", () => {
		expect(spreadingActivation([{ fan: 1, weight: 2 }])).toBeCloseTo(3.2, 10);
	});

	test("a specific cue beats a broad one even when the broad one is shared", () => {
		const broadOnly = spreadingActivation([{ fan: 3000 }]);
		const broadAndSpecific = spreadingActivation([{ fan: 3000 }, { fan: 3 }]);
		expect(broadAndSpecific).toBeGreaterThan(broadOnly);
	});
});

describe("logisticNoise", () => {
	test("is zero at the median", () => {
		expect(logisticNoise(0.25, fixedRandom)).toBe(0);
	});

	test("is symmetric and scaled", () => {
		const high = logisticNoise(0.25, () => 0.9);
		const low = logisticNoise(0.25, () => 0.1);
		expect(high).toBeCloseTo(-low, 10);
		expect(logisticNoise(0.5, () => 0.9)).toBeCloseTo(2 * high, 10);
	});

	test("never produces infinities at the edges", () => {
		expect(Number.isFinite(logisticNoise(0.25, () => 0))).toBe(true);
		expect(Number.isFinite(logisticNoise(0.25, () => 1))).toBe(true);
	});
});

describe("activation", () => {
	test("sums base level, spreading and noise", () => {
		const input = { useCount: 3, lifetimeHours: 10, sharedCues: [{ fan: 2 }] };
		const expected = baseLevelActivation(3, 10) + spreadingActivation([{ fan: 2 }]);
		expect(activation(input, defaultActivationParameters, fixedRandom)).toBeCloseTo(expected, 10);
	});

	test("context decides between two equally used memories", () => {
		const inContext = { useCount: 2, lifetimeHours: 5, sharedCues: [{ fan: 2 }, { fan: 4 }] };
		const outOfContext = { useCount: 2, lifetimeHours: 5, sharedCues: [] };
		expect(activation(inContext, defaultActivationParameters, fixedRandom)).toBeGreaterThan(
			activation(outOfContext, defaultActivationParameters, fixedRandom),
		);
	});
});

describe("retrievalProbability", () => {
	test("is 0.5 at the threshold", () => {
		expect(retrievalProbability(-0.5)).toBeCloseTo(0.5, 10);
	});

	test("rises monotonically with activation and saturates", () => {
		expect(retrievalProbability(0)).toBeGreaterThan(retrievalProbability(-1));
		expect(retrievalProbability(5)).toBeGreaterThan(0.99);
		expect(retrievalProbability(-5)).toBeLessThan(0.01);
	});

	test("a higher threshold makes the same memory less likely to intrude", () => {
		expect(retrievalProbability(0, 1)).toBeLessThan(retrievalProbability(0, -0.5));
	});
});
