import { expect, test } from "bun:test";
import { addDmnHooks, SettingsError } from "./settings.js";

const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
type Settings = {
	hooks: Record<string, { hooks: { command: string }[] }[]>;
	[key: string]: unknown;
};
const commandsOf = (settings: Record<string, unknown>, event: string): string[] =>
	(settings as Settings).hooks[event]?.flatMap((group) =>
		group.hooks.map((hook) => hook.command),
	) ?? [];

test("adds one dmn command hook per event, keeping unrelated hooks and keys", () => {
	const before = {
		model: "opus",
		hooks: {
			Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }],
		},
	};
	const after = addDmnHooks(before) as Settings;
	expect(after.model).toBe("opus");
	expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
	expect(commandsOf(after, "Stop")).toEqual(["notify-send done", "dmn hook stop"]);
	expect(commandsOf(after, "SessionStart")).toEqual(["dmn hook session-start"]);
	expect(commandsOf(after, "UserPromptSubmit")).toEqual(["dmn hook user-prompt"]);
	expect(commandsOf(after, "PostToolUse")).toEqual(["dmn hook post-tool"]);
	expect(before.hooks.Stop).toHaveLength(1);
});

test("running it again changes nothing", () => {
	const once = addDmnHooks({});
	const twice = addDmnHooks(once);
	expect(twice).toEqual(once);
	for (const event of events) expect(commandsOf(twice, event)).toHaveLength(1);
});

test("refuses a hooks value of the wrong shape instead of overwriting it", () => {
	expect(() => addDmnHooks({ hooks: [] })).toThrow(SettingsError);
	expect(() => addDmnHooks({ hooks: { Stop: {} } })).toThrow(SettingsError);
});
