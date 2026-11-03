import { afterAll, beforeAll, expect, test } from "bun:test";
import { bankFor, HindsightStore, isBankNotFound, StoreError } from "./hindsight.js";
import type { MemoryRecord, MentalModel } from "./types.js";

let oddServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
	oddServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname.endsWith("/memories/hang")) return new Promise<Response>(() => {});
			if (request.method === "POST" && pathname.endsWith("/memories")) {
				await Bun.sleep(150);
				return Response.json({ success: true });
			}
			if (pathname.endsWith("/banks/b/consolidate")) {
				// Consolidation is a POST with no body; anything else is not this endpoint answering.
				if (request.method !== "POST") return new Response("method", { status: 405 });
				if (request.body) return new Response("body", { status: 400 });
				return Response.json({ operation_id: "op-7", deduplicated: 3 });
			}
			if (pathname.endsWith("/banks/quiet/consolidate")) {
				return Response.json({ detail: "Bank 'quiet' not found" }, { status: 404 });
			}
			if (pathname.endsWith("/banks/late/consolidate")) {
				// An async answer that has not deduplicated yet carries no count at all.
				return Response.json({ operation_id: "op-8" });
			}
			return Response.json({ id: "x", text: "no timestamp" });
		},
	});
	baseUrl = `http://127.0.0.1:${oddServer.port}`;
});

afterAll(() => oddServer.stop(true));

/** One recorded request: where it went, how it was sent. */
interface RecordedRequest {
	url: string;
	method?: string | undefined;
	body?: unknown;
	contentType?: string | undefined;
}

/**
 * Runs `call` against a stubbed global fetch that records every request and answers from
 * `respond`, restoring the real one after. Asserts the adapter's request shapes exactly.
 */
async function stubbedFetch(
	respond: () => Response,
	call: () => Promise<void>,
): Promise<RecordedRequest[]> {
	const original = globalThis.fetch;
	const requests: RecordedRequest[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push({
			url: String(input),
			method: init?.method,
			body: init?.body === undefined ? undefined : JSON.parse(String(init?.body)),
			contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
		});
		return respond();
	}) as typeof fetch;
	try {
		await call();
	} finally {
		globalThis.fetch = original;
	}
	return requests;
}

test("mentalModels maps the listed models and skips any without a role tag", async () => {
	const store = new HindsightStore({ baseUrl: "http://stub" });
	let models: MentalModel[] = [];
	const requests = await stubbedFetch(
		() =>
			Response.json({
				items: [
					{
						id: "dmn-role-reviewer",
						content: "The reviewer cites the design doc. More.",
						tags: ["role:reviewer"],
						refreshed_at: "2026-06-01T00:00:00Z",
					},
					{
						id: "foreign",
						content: "another surface's model",
						tags: ["kind:other"],
						refreshed_at: "2026-06-01T00:00:00Z",
					},
					{ id: "dmn-role-operator", content: "no stamp yet", tags: ["role:operator"] },
				],
			}),
		async () => {
			models = await store.mentalModels("b");
		},
	);
	expect(requests).toEqual([
		{
			url: "http://stub/v1/default/banks/b/mental-models",
			method: "GET",
			body: undefined,
			contentType: undefined,
		},
	]);
	expect(models).toEqual([
		{
			id: "dmn-role-reviewer",
			role: "reviewer",
			content: "The reviewer cites the design doc. More.",
			refreshedAt: "2026-06-01T00:00:00Z",
		},
		{ id: "dmn-role-operator", role: "operator", content: "no stamp yet", refreshedAt: "" },
	]);
});

test("createMentalModel posts the documented body to the bank's mental-models path", async () => {
	const store = new HindsightStore({ baseUrl: "http://stub" });
	const requests = await stubbedFetch(
		() => Response.json({ id: "dmn-role-reviewer" }),
		async () => {
			await store.createMentalModel("b", {
				id: "dmn-role-reviewer",
				name: "dmn-role-reviewer",
				sourceQuery:
					"What the reviewer role's memories cover: the facts, decisions and habits this role relies on",
				tags: ["role:reviewer"],
				maxTokens: 512,
			});
		},
	);
	expect(requests).toEqual([
		{
			url: "http://stub/v1/default/banks/b/mental-models",
			method: "POST",
			body: {
				id: "dmn-role-reviewer",
				name: "dmn-role-reviewer",
				source_query:
					"What the reviewer role's memories cover: the facts, decisions and habits this role relies on",
				tags: ["role:reviewer"],
				max_tokens: 512,
			},
			contentType: "application/json",
		},
	]);
});

test("refreshMentalModel posts to the model's refresh path with no body", async () => {
	const store = new HindsightStore({ baseUrl: "http://stub" });
	const requests = await stubbedFetch(
		() => Response.json({ id: "dmn-role-reviewer" }),
		async () => {
			await store.refreshMentalModel("b", "dmn-role-reviewer");
		},
	);
	expect(requests).toEqual([
		{
			url: "http://stub/v1/default/banks/b/mental-models/dmn-role-reviewer/refresh",
			method: "POST",
			body: undefined,
			contentType: undefined,
		},
	]);
});

test("a bank the store does not know lists its mental models as empty, not an error", async () => {
	const store = new HindsightStore({ baseUrl: "http://stub" });
	const requests = await stubbedFetch(
		() => Response.json({ detail: "Bank 'quiet' not found" }, { status: 404 }),
		async () => {
			await expect(store.mentalModels("quiet")).resolves.toEqual([]);
		},
	);
	expect(requests).toHaveLength(1);
});

test("bankFor maps organizations to org-<name> and no organization to generic", () => {
	expect(bankFor("acme")).toBe("org-acme");
	expect(bankFor(undefined)).toBe("generic");
	expect(bankFor("generic")).toBe("generic");
});

test("retain sends the content time as timestamp beside the document id", async () => {
	const store = new HindsightStore({ baseUrl: "http://stub" });
	const requests = await stubbedFetch(
		() => Response.json({ success: true }),
		async () => {
			await store.retain("b", [
				{
					content: "the retry cap was lowered",
					tags: ["kind:turn"],
					documentId: "live-a.jsonl:0:user",
					timestamp: "2026-01-02T09:00:00.000Z",
				},
				{ content: "no timestamp given", tags: [] },
			]);
		},
	);
	expect(requests).toEqual([
		{
			url: "http://stub/v1/default/banks/b/memories",
			method: "POST",
			contentType: "application/json",
			body: {
				items: [
					{
						content: "the retry cap was lowered",
						tags: ["kind:turn"],
						document_id: "live-a.jsonl:0:user",
						timestamp: "2026-01-02T09:00:00.000Z",
					},
					{ content: "no timestamp given", tags: [] },
				],
				async: false,
			},
		},
	]);
});

test("toRecord takes createdAt from the content-time fields, created_at as the fallback", async () => {
	const store = new HindsightStore({ baseUrl: "http://stub" });
	// The wire shape this Hindsight answers: `date` on list/get, `mentioned_at` on recall — both
	// carry the retain timestamp — and an ingest-only `created_at` must not win over either.
	let fetched: MemoryRecord | undefined;
	await stubbedFetch(
		() =>
			Response.json({
				id: "00000000-0000-4000-8000-000000000009",
				text: "the retry cap was lowered",
				date: "2026-01-02T09:00:00+00:00",
				mentioned_at: "2026-01-02T09:00:00+00:00",
				created_at: "2026-11-03T16:00:00+00:00",
			}),
		async () => {
			fetched = (await store.get("b", "00000000-0000-4000-8000-000000000009")) ?? undefined;
		},
	);
	expect(fetched).toMatchObject({ createdAt: "2026-01-02T09:00:00+00:00" });

	// An answer with no content-time field falls back to created_at, the ingest time.
	let ingest: MemoryRecord | undefined;
	await stubbedFetch(
		() =>
			Response.json({
				id: "00000000-0000-4000-8000-000000000010",
				text: "an old server's memory",
				created_at: "2026-11-03T16:00:00+00:00",
			}),
		async () => {
			ingest = (await store.get("b", "00000000-0000-4000-8000-000000000010")) ?? undefined;
		},
	);
	expect(ingest).toMatchObject({ createdAt: "2026-11-03T16:00:00+00:00" });
});

test("a hung store aborts at timeoutMs as a StoreError with status 0", async () => {
	const hung = new HindsightStore({ baseUrl, timeoutMs: 50 });
	const error = await hung.get("b", "hang").catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).status).toBe(0);
});

test("retain waits up to retainTimeoutMs, longer than timeoutMs", async () => {
	const patient = new HindsightStore({ baseUrl, timeoutMs: 50, retainTimeoutMs: 2000 });
	await expect(patient.retain("b", [{ content: "x", tags: [] }])).resolves.toBeUndefined();
});

test("a record without any timestamp is a StoreError, not an empty createdAt", async () => {
	const odd = new HindsightStore({ baseUrl });
	await expect(odd.get("b", "x")).rejects.toThrow(/no timestamp/);
});

test("consolidate posts to the bank's consolidate path with no body and maps the response", async () => {
	const store = new HindsightStore({ baseUrl });
	await expect(store.consolidate("b")).resolves.toEqual({ operationId: "op-7", deduplicated: 3 });
	// A count the answer does not carry yet maps to zero, the pinned fallback.
	await expect(store.consolidate("late")).resolves.toEqual({
		operationId: "op-8",
		deduplicated: 0,
	});
	// A bank the store does not know is the skip signal, not some other empty answer.
	const error = await store.consolidate("quiet").catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).status).toBe(404);
	expect(isBankNotFound(error)).toBe(true);
});
