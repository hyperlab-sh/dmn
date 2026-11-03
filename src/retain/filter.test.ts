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
	{ fixture: "credential-assignment.txt", role: "user", reason: "credential-assignment" },
	{ fixture: "question.txt", role: "user" },
	{ fixture: "answer.txt", role: "assistant" },
];

for (const { fixture, role, reason } of rows) {
	test(`${fixture} is ${reason ? `dropped as ${reason}` : "retained"}`, () => {
		const verdict = shouldRetain({ role, text: read(fixture) });
		expect(verdict).toEqual(reason ? { retain: false, reason } : { retain: true });
		if (fixture === "credential-assignment.txt") {
			// Every line must be caught on its own, so no pattern hides another's gap.
			for (const line of read(fixture).split("\n").slice(1).filter(Boolean)) {
				expect(shouldRetain({ role, text: line })).toEqual({
					retain: false,
					reason: "credential-assignment",
				});
			}
		}
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
		"DATABASE_URL=postgres://app:s3cr3t@db.example.test:5432/app",
		`stripe ${["sk_", "live_", "F".repeat(24)].join("")}`,
		"authorization: basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==",
		`jwt ${["eyJ", "F".repeat(12), ".eyJ", "F".repeat(12), ".", "F".repeat(12)].join("")}`,
	];
	for (const text of lines) {
		expect(shouldRetain({ role: "user", text }).retain).toBe(false);
	}
});

test("type-like values after a keyword are ordinary code", () => {
	for (const text of ["type User = { password: string }", "apiKey: string;", "token: number"]) {
		expect(shouldRetain({ role: "assistant", text })).toEqual({ retain: true });
	}
});
