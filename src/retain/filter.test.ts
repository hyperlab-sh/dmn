import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldRetain, type Turn } from "./filter.js";

const read = (name: string) =>
	readFileSync(join(import.meta.dir, "../../fixtures/retain", name), "utf8");

const rows: { fixture: string; role: Turn["role"]; reason?: string }[] = [
	{ fixture: "cross-session.txt", role: "user", reason: "cross-session-message" },
	{ fixture: "orchestration.txt", role: "user", reason: "orchestration-message" },
	{ fixture: "file-indexing.txt", role: "user", reason: "file-indexing" },
	{ fixture: "system-reminder.txt", role: "user", reason: "system-reminder" },
	{ fixture: "secret-github.txt", role: "user", reason: "secret" },
	{ fixture: "secret-sk.txt", role: "assistant", reason: "secret" },
	{ fixture: "secret-bearer.txt", role: "assistant", reason: "secret" },
	{ fixture: "secret-aws.txt", role: "user", reason: "secret" },
	{ fixture: "env-assignment.txt", role: "user", reason: "env-assignment" },
	{ fixture: "question.txt", role: "user" },
	{ fixture: "answer.txt", role: "assistant" },
];

for (const { fixture, role, reason } of rows) {
	test(`${fixture} is ${reason ? `dropped as ${reason}` : "retained"}`, () => {
		const verdict = shouldRetain({ role, text: read(fixture) });
		expect(verdict).toEqual(reason ? { retain: false, reason } : { retain: true });
	});
}

test("a blank turn is dropped", () => {
	expect(shouldRetain({ role: "user", text: " \n" })).toEqual({ retain: false, reason: "empty" });
});

test("a long list of paths that asks a question is an ordinary turn", () => {
	const text = `${read("file-indexing.txt")}Which of these files owns the auth flow?`;
	expect(shouldRetain({ role: "user", text })).toEqual({ retain: true });
});
