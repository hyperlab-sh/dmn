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

/** `owner` and `repo` of a GitHub remote URL (https, ssh or scp-like). */
function parseGithubOrigin(url: string): { owner: string; repo: string } | undefined {
	const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}

function skillKey(skill: string | undefined): string | undefined {
	if (!skill) return undefined;
	const name = skill.replace(/^\//, "");
	return name.slice(name.lastIndexOf(":") + 1);
}

function resolveWhere(input: CueInput): { organization: string; project: string } {
	const origin = input.originUrl ? parseGithubOrigin(input.originUrl) : undefined;
	if (input.spaceRoot) {
		const segments = input.spaceRoot.split("/").filter(Boolean);
		const space = segments.pop() || "none";
		// The mapping key is the directory the space sits under, not the space itself.
		const root = segments.pop() ?? "";
		return {
			organization: input.organizations[root] ?? origin?.owner ?? "generic",
			project: space,
		};
	}
	if (origin) return { organization: origin.owner, project: origin.repo };
	return { organization: "generic", project: "none" };
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
