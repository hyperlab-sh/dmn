import { expect, test } from "bun:test";
import { bankFor } from "./hindsight.js";

test("bankFor maps organizations to org-<name> and no organization to generic", () => {
	expect(bankFor("acme")).toBe("org-acme");
	expect(bankFor(undefined)).toBe("generic");
	expect(bankFor("generic")).toBe("generic");
});
