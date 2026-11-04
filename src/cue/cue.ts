import { detectStack, type Manifest } from "./stack.js";
import { detectTask, hasEdit, type Task } from "./task.js";

export type Role = "architect" | "developer" | "reviewer" | "operator" | "unknown";
export type { Task };

export type Cue = {
	organization: string;
	project: string;
	stack: string[];
	role: Role;
	task: Task;
};

export type CueInput = {
	cwd: string;
	/** Nearest ancestor of cwd holding `HYPER.md`. */
	spaceRoot?: string;
	/** `remote.origin.url` of the repository, when there is one. */
	originUrl?: string;
	manifests: Manifest[];
	activeSkill?: string;
	/** `Name` or `Name:input` entries, oldest first. */
	recentTools: string[];
	/** Space directory name → organization. Configuration, never hard-coded. */
	organizations: Record<string, string>;
};

const roleBySkill: Record<string, Role> = {
	"code-review": "reviewer",
	"arch-review": "architect",
	spec: "architect",
	plan: "architect",
	ship: "operator",
	land: "operator",
	unit: "operator",
};

const taskBySkill: Record<string, Task> = {
	"code-review": "review",
	"arch-review": "review",
	plan: "plan",
	spec: "plan",
};

/** Repository name (any host) and, for GitHub remotes only, the owner. */
function parseOrigin(url: string): { owner?: string; repo: string } | undefined {
	const github = /(?:^|[@/])github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	if (github?.[1] && github[2]) return { owner: github[1].toLowerCase(), repo: github[2] };
	const repo = /([^/:\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
	return repo ? { repo } : undefined;
}

function skillKey(skill: string | undefined): string | undefined {
	if (!skill) return undefined;
	const name = skill.replace(/^\//, "");
	return name.slice(name.lastIndexOf(":") + 1);
}

function resolveWhere(input: CueInput): { organization: string; project: string } {
	const origin = input.originUrl ? parseOrigin(input.originUrl) : undefined;
	if (input.spaceRoot) {
		const segments = input.spaceRoot.split(/[\\/]/).filter(Boolean);
		const space = segments.pop() || "none";
		// The mapping key is the directory the space sits under, not the space itself.
		const root = segments.pop() ?? "";
		const mapped = Object.hasOwn(input.organizations, root) ? input.organizations[root] : undefined;
		return {
			organization: mapped ?? origin?.owner ?? "generic",
			project: space,
		};
	}
	if (origin) return { organization: origin.owner ?? "generic", project: origin.repo };
	return whereFromPath(input.cwd, input.organizations);
}

/**
 * Where the path alone says we are (D42, D44): the project is the segment before a `worktrees`
 * segment when the path has one (a worktree belongs to the space around it), else the segment
 * right after the first directory named in `organizations` (the mapped organization directory
 * anchors the project in the space it opens), else the last segment; the organization is the
 * `organizations` mapping on the parent of that segment, else `generic`. The last resort of
 * `resolveWhere`: a recorded cwd no scan can reach, or a live cwd outside any repository, gets
 * the same answer.
 */
function whereFromPath(
	cwd: string,
	organizations: Record<string, string>,
): { organization: string; project: string } {
	const segments = cwd.split(/[\\/]/).filter(Boolean);
	const worktrees = segments.indexOf("worktrees");
	const anchor = segments.findIndex(
		(segment, index) => index + 1 < segments.length && Object.hasOwn(organizations, segment),
	);
	let at: number;
	if (worktrees > 0) at = worktrees - 1;
	else if (anchor >= 0) at = anchor + 1;
	else at = segments.length - 1;
	const project = segments[at] ?? "none";
	const parent = segments[at - 1] ?? "";
	const mapped = Object.hasOwn(organizations, parent) ? organizations[parent] : undefined;
	return { organization: mapped ?? "generic", project };
}

/** Pure: the same input always gives the same cue. */
export function buildCue(input: CueInput): Cue {
	const skill = skillKey(input.activeSkill);
	const role: Role =
		(skill ? roleBySkill[skill] : undefined) ||
		(hasEdit(input.recentTools) ? "developer" : "unknown");
	const toolTask = detectTask(input.recentTools);
	const task =
		toolTask === "test" ? toolTask : ((skill ? taskBySkill[skill] : undefined) ?? toolTask);
	return { ...resolveWhere(input), stack: detectStack(input.manifests), role, task };
}

/** Tags that match memories softly; organization is the bank, never a tag. */
export function softTags(cue: Cue): string[] {
	return [
		`project:${cue.project}`,
		...[...cue.stack].sort().map((label) => `stack:${label}`),
		`role:${cue.role}`,
		`task:${cue.task}`,
	];
}

/** One-line phrase used as the recall query when there is no prompt. */
export function cueText(cue: Cue): string {
	const stack = cue.stack.length > 0 ? ` (${cue.stack.join(" ")})` : "";
	return `${cue.role} working on ${cue.project}${stack}, task: ${cue.task}`;
}
