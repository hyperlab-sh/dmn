import type { HookEventName } from "./claude-code.js";

export type ClaudeSettings = Record<string, unknown>;

export class SettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsError";
	}
}

/** Claude Code event → the `dmn hook` subcommand that handles it. */
export const dmnHooks: ReadonlyArray<{ event: HookEventName; subcommand: string }> = [
	{ event: "SessionStart", subcommand: "session-start" },
	{ event: "UserPromptSubmit", subcommand: "user-prompt" },
	{ event: "PostToolUse", subcommand: "post-tool" },
	{ event: "Stop", subcommand: "stop" },
];

type HookGroup = { hooks?: { type?: unknown; command?: unknown }[] };

/**
 * Pure: returns settings with one `dmn hook <sub>` command hook per event. Everything else is
 * kept as it is, and an event that already runs the command is left alone.
 */
export function addDmnHooks(settings: ClaudeSettings): ClaudeSettings {
	const existing = settings.hooks;
	if (
		existing !== undefined &&
		(typeof existing !== "object" || existing === null || Array.isArray(existing))
	) {
		throw new SettingsError('"hooks" in the settings file is not an object');
	}
	const hooks: Record<string, unknown> = { ...(existing as Record<string, unknown> | undefined) };
	for (const { event, subcommand } of dmnHooks) {
		const groups = hooks[event] ?? [];
		if (!Array.isArray(groups)) {
			throw new SettingsError(`"hooks.${event}" in the settings file is not an array`);
		}
		const command = `dmn hook ${subcommand}`;
		const present = (groups as HookGroup[]).some((group) =>
			group?.hooks?.some((hook) => hook?.type === "command" && hook.command === command),
		);
		hooks[event] = present ? groups : [...groups, { hooks: [{ type: "command", command }] }];
	}
	return { ...settings, hooks };
}
