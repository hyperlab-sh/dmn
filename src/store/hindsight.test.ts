import { afterAll, beforeAll, expect, test } from "bun:test";
import { bankFor, HindsightStore, StoreError } from "./hindsight.js";

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
