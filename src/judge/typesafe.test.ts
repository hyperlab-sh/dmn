import { expect, test } from "bun:test";
import { JudgeError } from "./types.js";
import { TypeSafeJudge } from "./typesafe.js";

interface Recorded {
	url: string;
	headers: Record<string, string>;
	body: { model: string; state: string; questions: Record<string, unknown> };
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
	model: "jev-1.14.0",
	answers: {
		useful: { type: "noul", noul: useful },
		level: { type: "score", score: level },
	},
	usage: { input_tokens: 480, output_tokens: 68 },
});
const ok =
	(useful = 0.4, level = 1.2) =>
	() =>
		Response.json(answers(useful, level));
const status =
	(code: number, headers: Record<string, string> = {}) =>
	() =>
		new Response("nope", { status: code, headers });

function judgeWith(replies: (() => Response)[], sleeps: number[] = []) {
	const { recorded, fetcher } = fakeFetch(replies);
	const judge = new TypeSafeJudge({
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

test("one POST per memory: bearer key, model, the Laya state text and the useful and level questions", async () => {
	const { judge, recorded } = judgeWith([ok(0.9, 2.5), ok(0.2, 0.5)]);
	const out = await judge.judge("the prompt", [memory("m-1", "first"), memory("m-2", "second")]);
	// In input order, useful from answers.useful.noul and level from answers.level.score.
	expect(out).toEqual([
		{ id: "m-1", useful: 0.9, level: 2.5 },
		{ id: "m-2", useful: 0.2, level: 0.5 },
	]);
	expect(recorded).toHaveLength(2);
	for (const request of recorded) {
		expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(request.headers.authorization).toBe("Bearer secret-key");
		expect(request.headers["content-type"]).toBe("application/json");
		expect(request.body.model).toBe("jev-latest");
		// No ids, tags or metadata leave the machine: the body is model, state and questions.
		const wire = JSON.stringify(request.body);
		expect(wire).not.toContain("m-1");
		expect(Object.keys(request.body).sort()).toEqual(["model", "questions", "state"]);
	}
	expect(recorded.map((request) => request.body.state)).toEqual([
		"Prompt from the engineer:\nthe prompt\n\nMemory from a past session:\nfirst",
		"Prompt from the engineer:\nthe prompt\n\nMemory from a past session:\nsecond",
	]);
	expect(recorded[0]?.body.questions).toEqual({
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
	// judge.baseUrl overrides, and a trailing slash is not doubled into the path.
	const local = fakeFetch([ok()]);
	const overridden = new TypeSafeJudge({
		apiKey: "k",
		baseUrl: "http://localhost:9000/",
		fetch: local.fetcher,
		sleep: async () => {},
		random: () => 0.5,
	});
	await overridden.judge("p", [memory("a")]);
	expect(local.recorded[0]?.url).toBe("http://localhost:9000/v1/systemone");
});

test("trims memory text to 1500 characters, clamps answers, and an empty input sends nothing", async () => {
	const { judge, recorded } = judgeWith([ok(1.4, -0.2)]);
	const out = await judge.judge("p", [memory("m-1", "x".repeat(2000))]);
	expect(out).toEqual([{ id: "m-1", useful: 1, level: 0 }]);
	const state = recorded[0]?.body.state as string;
	expect(state.endsWith(`past session:\n${"x".repeat(1500)}`)).toBe(true);
	expect(await judge.judge("p", [])).toEqual([]);
	expect(recorded).toHaveLength(1);
});

const kindAnswer = (choice: string, probabilities: Record<string, number>) => ({
	answers: { kind: { type: "choice", choice, probabilities } },
});
const okKind =
	(choice = "turn", probability = 0.9) =>
	() =>
		Response.json(kindAnswer(choice, { [choice]: probability }));

test("classify sends one kind choice question per text and maps choice and probability by index", async () => {
	const { judge, recorded } = judgeWith([
		() => Response.json(kindAnswer("learning", { turn: 0.2, learning: 0.7, decision: 0.1 })),
		// answers without a kind: unanswered, like an item the service refused.
		() => Response.json({ answers: {} }),
		okKind("sideways"),
		okKind("decision", 1.4),
	]);
	const texts = ["first turn", "second turn", "third turn", `${"x".repeat(2000)}`];
	expect(await judge.classify(texts)).toEqual([
		{ index: 0, kind: "learning", probability: 0.7 },
		// Probabilities are clamped to [0, 1]; a choice outside the criteria is unanswered.
		{ index: 3, kind: "decision", probability: 1 },
	]);
	const [first, , , fourth] = recorded;
	// The state is the bare text (cut to 1500): nothing but the text leaves the machine.
	expect(first?.body.state).toBe("first turn");
	expect(fourth?.body.state?.length).toBe(1500);
	for (const request of recorded) {
		expect(request.body.model).toBe("jev-latest");
		expect(Object.keys(request.body).sort()).toEqual(["model", "questions", "state"]);
	}
	expect(recorded[0]?.body.questions).toEqual({
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
	expect(await judge.classify([])).toEqual([]);
	expect(recorded).toHaveLength(4);
});

test("a non-2xx or a missing answer for one item leaves it out; the others stand", async () => {
	const missing = () => Response.json({ answers: { useful: { type: "noul", noul: 0.5 } } });
	const { judge, recorded } = judgeWith([ok(0.9, 2.5), status(400), missing]);
	const out = await judge.judge("p", [memory("m-1"), memory("m-2"), memory("m-3")]);
	// m-2's request answered 400 and m-3's answer has no level: both are unanswered, m-1 stands.
	expect(out).toEqual([{ id: "m-1", useful: 0.9, level: 2.5 }]);
	expect(recorded).toHaveLength(3);
});

test("retries 429 and 503 honouring Retry-After, with jittered backoff otherwise", async () => {
	const sleeps: number[] = [];
	const { judge, recorded } = judgeWith(
		[status(429, { "retry-after": "3" }), status(503), ok()],
		sleeps,
	);
	expect(await judge.judge("p", [memory("a")])).toHaveLength(1);
	expect(recorded).toHaveLength(3);
	// random() = 0.5: Retry-After wins over the 375 ms backoff; then 500 * 2 * 0.75.
	expect(sleeps).toEqual([3000, 750]);
});

test("gives up after 5 attempts on 429 and names the status", async () => {
	const { judge, recorded, sleeps } = judgeWith([status(429)]);
	const error = await judge.judge("p", [memory("a")]).catch((thrown) => thrown);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.status).toBe(429);
	expect(recorded).toHaveLength(5);
	expect(sleeps).toHaveLength(4);
});

test.each([400, 401, 402, 422])("throws JudgeError naming %d without retrying", async (code) => {
	const { judge, recorded } = judgeWith([status(code)]);
	const error = await judge.judge("p", [memory("a")]).catch((thrown) => thrown);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.status).toBe(code);
	expect(error.message).toContain(String(code));
	expect(error.message).not.toContain("secret-key");
	expect(recorded).toHaveLength(1);
});

test("a malformed or non-JSON 2xx response is a JudgeError", async () => {
	const bad = judgeWith([() => Response.json({ answers: {} })]);
	await expect(bad.judge.judge("p", [memory("a")])).resolves.toEqual([]);
	const html = judgeWith([() => new Response("<html>", { status: 200 })]);
	await expect(html.judge.judge("p", [memory("a")])).rejects.toThrow("response is not JSON");
});

test("Retry-After as an HTTP date is read against the injected clock", async () => {
	const { recorded, fetcher } = fakeFetch([
		status(429, { "retry-after": "Wed, 21 Oct 2015 07:28:10 GMT" }),
		ok(),
	]);
	const sleeps: number[] = [];
	const judge = new TypeSafeJudge({
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

test("a deadline stops the whole call instead of waiting past it", async () => {
	const sleeps: number[] = [];
	let clock = 0;
	const { recorded, fetcher } = fakeFetch([status(429, { "retry-after": "60" })]);
	const judge = new TypeSafeJudge({
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

test("a deadline spans the item pool: later waves inherit the spent budget", async () => {
	const sleeps: number[] = [];
	let clock = 0;
	// 12 texts force a second wave; every request answers 429 with a long Retry-After.
	const { recorded, fetcher } = fakeFetch([status(429, { "retry-after": "90" })]);
	const judge = new TypeSafeJudge({
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
	const texts = Array.from({ length: 12 }, (_, index) => `text ${index}`);
	const error = await judge.classify(texts).catch((thrown) => thrown);
	expect(error).toBeInstanceOf(JudgeError);
	expect(error.message).toContain("deadline");
	// The first wave abandoned on the deadline; the queued four never left, and nothing slept.
	expect(recorded).toHaveLength(8);
	expect(sleeps).toEqual([]);

	// And when the first wave answered before the budget ran out, the deadline still rejects
	// the whole call instead of returning the answers it already had (as Laya's batches do).
	let requests = 0;
	let slowClock = 0;
	const slow = (async () => {
		requests += 1;
		slowClock += 625; // each answered request costs an eighth of the 5 s budget
		return okKind();
	}) as unknown as typeof fetch;
	const answered = new TypeSafeJudge({
		apiKey: "k",
		fetch: slow,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0,
		now: () => slowClock,
		deadlineMs: 5000,
	});
	const spent = await answered.classify(texts).catch((thrown) => thrown);
	expect(spent).toBeInstanceOf(JudgeError);
	expect(spent.message).toContain("deadline");
	// The first wave's eight requests spent the budget; items 8..11 were never sent.
	expect(requests).toBe(8);
	expect(sleeps).toEqual([]);
});

test("no more than 8 requests are in flight at once, and answers come back in input order", async () => {
	let active = 0;
	let maxInFlight = 0;
	let requests = 0;
	const counting = (async () => {
		requests += 1;
		active += 1;
		maxInFlight = Math.max(maxInFlight, active);
		// A microtask yield: every pooled worker enters its request before any completes.
		await Promise.resolve();
		active -= 1;
		return ok()();
	}) as unknown as typeof fetch;
	const judge = new TypeSafeJudge({
		apiKey: "k",
		fetch: counting,
		sleep: async () => {},
		random: () => 0.5,
	});
	const memories = Array.from({ length: 20 }, (_, index) => memory(`m-${index}`));
	const out = await judge.judge("p", memories);
	expect(requests).toBe(20);
	expect(maxInFlight).toBe(8);
	expect(out.map((judgement) => judgement.id)).toEqual(memories.map((item) => item.id));
});
