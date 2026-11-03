import { expect, test } from "bun:test";
import { LayaJudge } from "./laya.js";
import { JudgeError } from "./types.js";

interface Recorded {
	url: string;
	headers: Record<string, string>;
	body: { requests: { state: string; questions: Record<string, unknown> }[] };
}

/** A fetch that records requests and answers from `replies` in turn (the last repeats). */
function fakeFetch(replies: (() => Response)[]) {
	const recorded: Recorded[] = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		recorded.push({
			url,
			headers: init.headers as Record<string, string>,
			body: JSON.parse(init.body as string),
		});
		const reply = replies[Math.min(recorded.length - 1, replies.length - 1)] as () => Response;
		return reply();
	}) as unknown as typeof fetch;
	return { recorded, fetcher };
}

const answers = (useful: number, level: number) => ({
	answers: { useful: { type: "noul", noul: useful }, level: { type: "score", score: level } },
});
const ok =
	(count: number, useful = 0.4, level = 1.2) =>
	() =>
		Response.json({ results: Array.from({ length: count }, () => answers(useful, level)) });
const status =
	(code: number, headers: Record<string, string> = {}) =>
	() =>
		new Response("nope", { status: code, headers });

function judgeWith(replies: (() => Response)[], sleeps: number[] = []) {
	const { recorded, fetcher } = fakeFetch(replies);
	const judge = new LayaJudge({
		apiKey: "secret-key",
		fetch: fetcher,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0.5,
	});
	return { judge, recorded, sleeps };
}

const memory = (id: string, text = "text") => ({ id, text });

test("one batch item per memory, plain-text state, two questions, bearer key, only text sent", async () => {
	const { judge, recorded } = judgeWith([ok(2, 0.9, 2.5)]);
	const out = await judge.judge("the prompt", [memory("m-1", "first"), memory("m-2", "second")]);
	expect(out).toEqual([
		{ id: "m-1", useful: 0.9, level: 2.5 },
		{ id: "m-2", useful: 0.9, level: 2.5 },
	]);
	const [request] = recorded;
	expect(request?.url).toBe("https://api.laya.studio/v1/systemone/batch");
	expect(request?.headers.authorization).toBe("Bearer secret-key");
	expect(request?.body.requests.map((item) => item.state)).toEqual([
		"Prompt from the engineer:\nthe prompt\n\nMemory from a past session:\nfirst",
		"Prompt from the engineer:\nthe prompt\n\nMemory from a past session:\nsecond",
	]);
	expect(request?.body.requests[0]?.questions).toEqual({
		useful: {
			type: "noul",
			instructions: "Would the memory help the engineer do what the prompt asks?",
			criteria: {
				true: "The memory tells the engineer something they need to do what the prompt asks",
				false: "The memory tells the engineer nothing they need to do what the prompt asks",
			},
		},
		level: {
			type: "score",
			instructions: "How much the memory helps the engineer do what the prompt asks.",
			criteria: [
				"useless: unrelated to the prompt",
				"background: about the same project or area, but not needed for this prompt",
				"helpful: contains something relevant the engineer can use for this prompt",
				"decisive: contains the fact or decision the engineer needs to do what the prompt asks",
			],
		},
	});
	// No ids, tags or metadata leave the machine: the body is states and questions only.
	const wire = JSON.stringify(request?.body);
	expect(wire).not.toContain("m-1");
	expect(Object.keys(request?.body.requests[0] ?? {}).sort()).toEqual(["questions", "state"]);
});

test("splits above 64 into several calls, trims memory text, clamps answers", async () => {
	const { judge, recorded } = judgeWith([ok(64), ok(1, 1.4, -0.2)]);
	const memories = Array.from({ length: 65 }, (_, i) => memory(`m-${i}`, "x".repeat(2000)));
	const out = await judge.judge("p", memories);
	expect(recorded.map((call) => call.body.requests.length)).toEqual([64, 1]);
	expect(out).toHaveLength(65);
	expect(out[64]).toEqual({ id: "m-64", useful: 1, level: 0 });
	const state = recorded[0]?.body.requests[0]?.state as string;
	expect(state.endsWith(`past session:\n${"x".repeat(1500)}`)).toBe(true);
	expect(await judge.judge("p", [])).toEqual([]);
	expect(recorded).toHaveLength(2);
});

test("retries 429 and 503 honouring Retry-After, with jittered backoff otherwise", async () => {
	const sleeps: number[] = [];
	const { judge, recorded } = judgeWith(
		[status(429, { "retry-after": "3" }), status(503), ok(1)],
		sleeps,
	);
	expect(await judge.judge("p", [memory("a")])).toHaveLength(1);
	expect(recorded).toHaveLength(3);
	// random() = 0.5: Retry-After wins over the 375 ms backoff; then 500 * 2 * 0.75.
	expect(sleeps).toEqual([3000, 750]);
});

test("gives up after 5 attempts on 429 and names the status", async () => {
	const { judge, recorded, sleeps } = judgeWith([status(429)]);
	const error = await judge.judge("p", [memory("a")]).catch((e) => e);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.status).toBe(429);
	expect(recorded).toHaveLength(5);
	expect(sleeps).toHaveLength(4);
});

test.each([400, 401, 402, 422])("throws JudgeError naming %d without retrying", async (code) => {
	const { judge, recorded } = judgeWith([status(code)]);
	const error = await judge.judge("p", [memory("a")]).catch((e) => e);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.status).toBe(code);
	expect(error.message).toContain(String(code));
	expect(error.message).not.toContain("secret-key");
	expect(recorded).toHaveLength(1);
});

test("a malformed or non-JSON 2xx response is a JudgeError", async () => {
	const bad = judgeWith([() => Response.json({ results: [] })]);
	await expect(bad.judge.judge("p", [memory("a")])).rejects.toBeInstanceOf(JudgeError);
	const html = judgeWith([() => new Response("<html>", { status: 200 })]);
	await expect(html.judge.judge("p", [memory("a")])).rejects.toThrow("response is not JSON");
});

test("Retry-After as an HTTP date is read against the injected clock", async () => {
	const { recorded, fetcher } = fakeFetch([
		status(429, { "retry-after": "Wed, 21 Oct 2015 07:28:10 GMT" }),
		ok(1),
	]);
	const sleeps: number[] = [];
	const judge = new LayaJudge({
		apiKey: "k",
		fetch: fetcher,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0,
		now: () => Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"),
	});
	await judge.judge("p", [memory("a")]);
	expect(recorded).toHaveLength(2);
	expect(sleeps).toEqual([10_000]);
});

test("an item the service answers with an error is left out; the others stand", async () => {
	const { judge } = judgeWith([
		() =>
			Response.json({
				results: [answers(0.9, 2), { error: { code: "invalid_request" } }],
			}),
	]);
	expect(await judge.judge("p", [memory("m-1"), memory("m-2")])).toEqual([
		{ id: "m-1", useful: 0.9, level: 2 },
	]);
});

const kindAnswer = (choice: string, probabilities: Record<string, number>) => ({
	answers: { kind: { type: "choice", choice, probabilities } },
});
const okKind =
	(count: number, choice = "turn", probability = 0.9) =>
	() =>
		Response.json({
			results: Array.from({ length: count }, () => kindAnswer(choice, { [choice]: probability })),
		});

test("classify sends one kind choice question per text and maps choice and probability by index", async () => {
	const { judge, recorded } = judgeWith([
		() =>
			Response.json({
				results: [
					kindAnswer("learning", { turn: 0.2, learning: 0.7, decision: 0.1 }),
					{ error: { code: "invalid_request" } },
					kindAnswer("sideways", { sideways: 1 }),
				],
			}),
	]);
	expect(await judge.classify(["first turn", "second turn", "third turn"])).toEqual([
		{ index: 0, kind: "learning", probability: 0.7 },
	]);
	const [request] = recorded;
	expect(request?.url).toBe("https://api.laya.studio/v1/systemone/batch");
	// The state is the bare text: nothing but the text leaves the machine.
	expect(request?.body.requests.map((item) => item.state)).toEqual([
		"first turn",
		"second turn",
		"third turn",
	]);
	expect(request?.body.requests[0]?.questions).toEqual({
		kind: {
			type: "choice",
			instructions: "Which kind of memory is this text?",
			criteria: {
				turn: "an exchange that only makes sense inside its own session",
				learning:
					"a fact about the code, the tools or the environment that will hold in a later session",
				decision: "a choice that was made and the reason for it",
			},
		},
	});
	expect(Object.keys(request?.body.requests[0] ?? {}).sort()).toEqual(["questions", "state"]);
});

test("classify batches above 64 texts and trims each state to 1500 characters", async () => {
	const { judge, recorded } = judgeWith([okKind(64), okKind(1, "learning", 1.4)]);
	const texts = Array.from({ length: 65 }, (_, index) => `${index} ${"x".repeat(2000)}`);
	const out = await judge.classify(texts);
	expect(recorded.map((call) => call.body.requests.length)).toEqual([64, 1]);
	expect(out).toHaveLength(65);
	expect(out[0]).toEqual({ index: 0, kind: "turn", probability: 0.9 });
	// The second batch's indexes continue the input's; probabilities are clamped to [0, 1].
	expect(out[64]).toEqual({ index: 64, kind: "learning", probability: 1 });
	expect(recorded[0]?.body.requests[0]?.state?.length).toBe(1500);
	expect(await judge.classify([])).toEqual([]);
	expect(recorded).toHaveLength(2);
});

test("a deadline stops the whole call instead of waiting past it", async () => {
	const sleeps: number[] = [];
	let clock = 0;
	const { recorded, fetcher } = fakeFetch([status(429, { "retry-after": "60" })]);
	const judge = new LayaJudge({
		apiKey: "k",
		fetch: fetcher,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		random: () => 0.5,
		now: () => clock,
		deadlineMs: 1000,
	});
	const error = await judge.classify(["a turn"]).catch((thrown) => thrown);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.message).toContain("deadline");
	// One attempt, no 60-second Retry-After wait: the budget bounds retries and waits too.
	expect(recorded).toHaveLength(1);
	expect(sleeps).toEqual([]);
});

test("a deadline splits across batches: the last batch inherits the spent budget", async () => {
	const sleeps: number[] = [];
	let clock = 0;
	// 65 texts force a second batch; both batches answer 429 with a long Retry-After.
	const { recorded, fetcher } = fakeFetch([status(429, { "retry-after": "90" })]);
	const judge = new LayaJudge({
		apiKey: "k",
		fetch: fetcher,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		random: () => 0,
		now: () => clock,
		deadlineMs: 5000,
	});
	const texts = Array.from({ length: 65 }, (_, index) => `text ${index}`);
	const error = await judge.classify(texts).catch((thrown) => thrown);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.message).toContain("deadline");
	// Only the first batch was attempted; the second never started, and nothing slept.
	expect(recorded).toHaveLength(1);
	expect(recorded[0]?.body.requests).toHaveLength(64);
	expect(sleeps).toEqual([]);
});
