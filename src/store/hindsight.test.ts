import { afterAll, beforeAll, expect, test } from "bun:test";
import { bankFor, HindsightStore, isBankNotFound, StoreError } from "./hindsight.js";

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
			return Response.json({ id: "x", text: "no timestamp" });
		},
	});
	baseUrl = `http://127.0.0.1:${oddServer.port}`;
});

afterAll(() => oddServer.stop(true));

test("bankFor maps organizations to org-<name> and no organization to generic", () => {
	expect(bankFor("acme")).toBe("org-acme");
	expect(bankFor(undefined)).toBe("generic");
	expect(bankFor("generic")).toBe("generic");
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
	// A bank the store does not know is the skip signal, not some other empty answer.
	const error = await store.consolidate("quiet").catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).status).toBe(404);
	expect(isBankNotFound(error)).toBe(true);
});
