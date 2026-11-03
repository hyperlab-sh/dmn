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
	const questions = request?.body.requests[0]?.questions as Record<string, { type: string }>;
	expect(Object.keys(questions)).toEqual(["useful", "level"]);
	expect(questions.useful?.type).toBe("noul");
	expect(questions.level?.type).toBe("score");
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

test("a malformed response is a JudgeError", async () => {
	const { judge } = judgeWith([() => Response.json({ results: [{ error: "bad" }] })]);
	expect(judge.judge("p", [memory("a")])).rejects.toBeInstanceOf(JudgeError);
});
