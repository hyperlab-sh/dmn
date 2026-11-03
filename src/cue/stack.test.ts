import { describe, expect, test } from "bun:test";
import { detectStack } from "./stack.js";

const m = (path: string, content = "") => ({ path, content });

describe("detectStack", () => {
	const rows: [string, Parameters<typeof detectStack>[0], string[]][] = [
		[
			"bun + tsconfig",
			[m("/r/package.json", '{"packageManager":"bun@1.2.0"}'), m("/r/tsconfig.json", "{}")],
			["bun", "typescript"],
		],
		["package.json alone", [m("/r/package.json", "{}")], ["javascript"]],
		[
			"typescript dependency",
			[m("/r/package.json", '{"devDependencies":{"typescript":"^5"}}')],
			["typescript"],
		],
		["pnpm", [m("/r/package.json", '{"packageManager":"pnpm@9.0.0"}')], ["javascript", "pnpm"]],
		["broken package.json", [m("/r/package.json", "{nope")], ["javascript"]],
		["Cargo.toml", [m("/r/Cargo.toml")], ["rust"]],
		["pyproject.toml", [m("/r/pyproject.toml")], ["python"]],
		["marko file", [m("/r/src/page.marko")], ["marko"]],
		[
			"duplicates collapse and sort",
			[m("/a/Cargo.toml"), m("/b/Cargo.toml"), m("/a/pyproject.toml")],
			["python", "rust"],
		],
		["nothing", [], []],
	];
	test.each(rows)("%s", (_name, manifests, expected) => {
		expect(detectStack(manifests)).toEqual(expected);
	});
});
