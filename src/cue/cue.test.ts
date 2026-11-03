import { describe, expect, test } from "bun:test";
import { buildCue, type CueInput, cueText, softTags } from "./cue.js";

const base: CueInput = {
	cwd: "/w/acme/widgets",
	manifests: [],
	recentTools: [],
	organizations: { acme: "acme-corp" },
};
const cue = (overrides: Partial<CueInput>) => buildCue({ ...base, ...overrides });

describe("organization and project", () => {
	const rows: [string, Partial<CueInput>, string, string][] = [
		["space under a mapped root", { spaceRoot: "/w/acme/widgets" }, "acme-corp", "widgets"],
		["space name is not the key", { spaceRoot: "/w/other/acme" }, "generic", "acme"],
		[
			"unmapped space with origin",
			{ spaceRoot: "/w/gadgets", originUrl: "git@github.com:initech/widgets.git" },
			"initech",
			"gadgets",
		],
		["unmapped space, no origin", { spaceRoot: "/w/gadgets" }, "generic", "gadgets"],
		[
			"https origin, no space",
			{ originUrl: "https://github.com/initech/widgets.git" },
			"initech",
			"widgets",
		],
		["ssh url origin", { originUrl: "ssh://git@github.com/initech/widgets" }, "initech", "widgets"],
		["non-github origin", { originUrl: "https://example.com/x/y.git" }, "generic", "none"],
		["neither", {}, "generic", "none"],
	];
	test.each(rows)("%s", (_name, overrides, organization, project) => {
		const result = cue(overrides);
		expect([result.organization, result.project]).toEqual([organization, project]);
	});
});

describe("role and task", () => {
	const roles: [string | undefined, string[], string][] = [
		["code-review", [], "reviewer"],
		["arch-review", [], "architect"],
		["spec", [], "architect"],
		["plan", [], "architect"],
		["ship", [], "operator"],
		["land", [], "operator"],
		["unit", [], "operator"],
		["/code-review", [], "reviewer"],
		["plugin:ship", [], "operator"],
		[undefined, ["Read", "Edit"], "developer"],
		[undefined, ["Read"], "unknown"],
		["unrelated", ["Write"], "developer"],
	];
	test.each(roles)("skill %s tools %j → role %s", (activeSkill, recentTools, role) => {
		expect(cue({ ...(activeSkill ? { activeSkill } : {}), recentTools }).role).toBe(role as never);
	});

	const tasks: [string | undefined, string[], string][] = [
		["code-review", [], "review"],
		["arch-review", ["Read"], "review"],
		["plan", [], "plan"],
		["spec", [], "plan"],
		["ship", [], "unknown"],
		["plan", ["Bash:bun test"], "test"],
	];
	test.each(tasks)("skill %s tools %j → task %s", (activeSkill, recentTools, task) => {
		expect(cue({ ...(activeSkill ? { activeSkill } : {}), recentTools }).task).toBe(task as never);
	});
});

test("same input twice gives deep-equal cues", () => {
	const input: CueInput = {
		...base,
		spaceRoot: "/w/acme/widgets",
		manifests: [{ path: "/w/acme/package.json", content: '{"packageManager":"bun@1"}' }],
		activeSkill: "plan",
		recentTools: ["Edit", "Bash:bun test"],
	};
	expect(buildCue(input)).toEqual(buildCue(structuredClone(input)));
});

describe("softTags and cueText", () => {
	const sample = {
		organization: "acme-corp",
		project: "acme",
		stack: ["typescript", "bun"],
		role: "developer",
		task: "edit",
	} as const;
	test("softTags: sorted stack, no organization", () => {
		expect(softTags({ ...sample, stack: [...sample.stack] })).toEqual([
			"project:acme",
			"stack:bun",
			"stack:typescript",
			"role:developer",
			"task:edit",
		]);
	});
	test("cueText: one line with project, stack and task", () => {
		const text = cueText({ ...sample, stack: [...sample.stack] });
		expect(text).not.toContain("\n");
		for (const word of ["acme", "typescript", "bun", "edit"]) expect(text).toContain(word);
	});
});
