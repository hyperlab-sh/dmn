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
	{ fixture: "secret-token.txt", role: "user", reason: "secret" },
	{ fixture: "credential-assignment.txt", role: "user", reason: "secret" },
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

test("each secret form is dropped on its own line", () => {
	const lines = [
		"use sk-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0000 here",
		'curl -H "Authorization: Bearer FAKEFAKEFAKEFAKEFAKE0000.fake.fake" https://api.example.test',
		"the access key is AKIAIOSFODNN7EXAMPLE",
		`google ${["AIza", "FAKE".repeat(8), "000"].join("")} key`,
		"gitlab glpat-FAKEFAKEFAKEFAKEFAKE0",
		`npm ${["npm_", "F".repeat(36)].join("")}`,
		"clone https://user:pat@github.com/acme/widgets.git",
		'{"api_key": "abcdef123456"}',
		"client_secret: abcdef123456",
		"STRIPE_KEY=abcdef",
	];
	for (const text of lines) {
		expect(shouldRetain({ role: "user", text }).retain).toBe(false);
	}
});

test("a bare assignment is dropped as a credential, not as a pattern match", () => {
	for (const text of ["password: correct-horse", "DATABASE_PASSWORD=hunter2"]) {
		expect(shouldRetain({ role: "user", text })).toEqual({
			retain: false,
			reason: "credential-assignment",
		});
	}
});
