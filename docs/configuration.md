# Configuration

dmn reads its settings from environment variables and from an optional `config.json`. Anything
that must be configured for dmn to work has no default: when it is missing the command exits
with status 2 and names it.

## Environment

| Variable          | Required                      | Meaning                                                                                                                                               |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DMN_STORE_URL`   | yes                           | Base URL of the memory store (a Hindsight server), or `fake:` for a throwaway in-memory store used by tests and dry runs.                             |
| `LAYA_API_KEY`    | with `judge.provider: "laya"` | API key of the Laya judge (`dmn hook`, `dmn replay`, `dmn replay judge`). Environment only: never put it in `config.json`. No default; unset exits 2. |
| `XDG_CONFIG_HOME` | no                            | Holds `dmn/config.json`. Falls back to `~/.config`.                                                                                                   |
| `XDG_STATE_HOME`  | no                            | Holds `dmn/state.sqlite` (use counts, dormancy). Falls back to `~/.local/state`.                                                                      |
| `XDG_DATA_HOME`   | no                            | Holds `dmn/replay/`. Falls back to `~/.local/share`.                                                                                                  |

## `config.json`

Located at `$XDG_CONFIG_HOME/dmn/config.json`. Every key is optional.

| Key                  | Default                                        | Meaning                                                                                        |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `budgetTokens`       | `600`                                          | Token budget of one injection (one token per four characters).                                 |
| `topK`               | `10`                                           | Candidates fetched per bank before reranking.                                                  |
| `promptThreshold`    | `-0.5`                                         | Activation above which a memory lends activation to its co-used associates (Co-use, below).    |
| `intrusionThreshold` | `0.5`                                          | Retrieval-probability threshold of intrusive thoughts; `null` turns them off (below).          |
| `intrusionCooldown`  | `5`                                            | Tool calls a session must make after an intrusive thought before the next.                     |
| `dormancyFloor`      | `-2.0`                                         | Base-level activation below which a memory may go dormant.                                     |
| `protectedTags`      | `decision`, `correction`, `identity`, `person` | Tags that keep a memory from going dormant.                                                    |
| `organizations`      | `{}`                                           | Maps the directory a hyper space sits under to an organization (below).                        |
| `storeTimeoutMs`     | `2000`                                         | Per-request limit for recall, so a hung store cannot stall a prompt.                           |
| `intrusionTimeoutMs` | `300`                                          | Store limit for the intrusive recall, which runs after tool calls; a slow store costs no more. |
| `retainTimeoutMs`    | `60000`                                        | Limit for retain, which waits on fact extraction.                                              |
| `fanCacheSeconds`    | `300`                                          | How long tag counts are cached.                                                                |
| `replayDir`          | `$XDG_DATA_HOME/dmn/replay`                    | Where replay runs are written.                                                                 |
| `activation`         | ACT-R defaults                                 | Overrides for the activation parameters, including `associationWeight` (default `0.5`).        |
| `judge`              | `{provider: "none", …}`                        | The usefulness judge (below).                                                                  |

### Judge

```json
{
	"judge": {
		"provider": "laya",
		"threshold": 0.5,
		"intrusionThreshold": 0.7,
		"baseUrl": "https://api.laya.studio",
		"timeoutMs": 30000
	}
}
```

| Key                  | Default                   | Meaning                                                                                                                                                                                                      |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`           | `none`                    | `none` or `laya`. With `laya`, `LAYA_API_KEY` must be set.                                                                                                                                                   |
| `threshold`          | `0.5`                     | Read by prompt-time recall (`SessionStart`, `UserPromptSubmit`): a candidate with P(useful) below it is not injected. Also by `replay judge` (marks `useful`) and `replay --judge` (the third order) (0..1). |
| `intrusionThreshold` | `0.7`                     | Read by the intrusive path: the one memory chosen to surface is judged and dropped below this (0..1). Not the activation `intrusionThreshold` above.                                                         |
| `baseUrl`            | `https://api.laya.studio` | Another server speaking the same API (for example a local model).                                                                                                                                            |
| `timeoutMs`          | `30000`                   | Per-call limit; a 64-item batch is slow, unlike a hook.                                                                                                                                                      |

With `provider: "none"` (the default) no judge exists and nothing is sent anywhere. With `laya`,
prompt-time recall makes one batch call per prompt and the intrusive path one single-memory call
per surfaced thought. A candidate the judge did not answer is kept. If the judge fails (network,
timeout, balance) the hook still succeeds: the injection is the unfiltered one, a warning goes to
stderr, and an intrusive thought is dropped. A prompt or memory that holds a secret is never sent.

See [Judge with Laya](replay.md#judge-with-laya).

### Organizations

A memory belongs to one organization's bank. The organization comes from the directory a hyper
space sits under (`<root>/<directory>/<space>/HYPER.md`), mapped by `organizations`. When the
directory is not mapped, the owner of a GitHub `origin` remote is used; outside any repository
the organization is `generic`.

```json
{
	"organizations": {
		"lab": "hyperlab",
		"mosaic": "mosaic"
	}
}
```

With that file, a session in `/work/lab/some-space/...` recalls from the `hyperlab` bank and the
`generic` bank, never from `mosaic`. The mapping is configuration; nothing is hard-coded.

## Intrusive thoughts

A developer sometimes remembers something when a file opens or a test fails, without asking.
After a tool call, `dmn hook post-tool` runs the prompt-time recall keyed by the tool's target (a
file's name and directory, or a command's name and letters-only subcommand) and the session's
cue, fetching 3 candidates per bank and reranking them. The best one surfaces as a single line,
`[m:<id>] <text>`, only when its retrieval probability against `intrusionThreshold` beats a
random draw. Most calls print nothing.

- `intrusionThreshold` (default `0.5`): a memory whose activation equals it surfaces half the
  time; a higher value makes intrusions rarer. It is higher than prompt-time recall on purpose.
- `intrusionCooldown` (default `5`): after a thought, this many tool calls pass before the next
  can surface. A session with no thought yet is never in cooldown.
- `intrusionTimeoutMs` (default `300`): how long the intrusive recall may wait for the store. A
  slow or down store costs a tool call at most this, then the thought is skipped.
- To turn intrusive thoughts off, set `"intrusionThreshold": null`. The hook then neither
  recalls nor prints.

A surfaced thought is not a use: it counts only if the assistant cites its marker later.

## Co-use

A co-use edge links two memories the assistant cited in the same turn, whatever their tags say. The
Stop hook adds 1 to the edge of every pair of distinct cited ids (once per turn, however often
the hook runs) and stamps when it last grew. Edges come only from citations: a memory that was
merely injected never earns one. They live in `state.sqlite`.

At recall, a memory associated with a candidate activated above `promptThreshold` gains
`associationWeight · (edge weight / that candidate's total edge weight) · max(0, S_max − ln(1 + fan))`,
where `fan` is the number of memories associated with the lending candidate. The terms are
summed over the lenders, computed once from the activations before the association is added, and
shown as `assoc=` on the replay report's activation line. Set `activation.associationWeight` to
`0` to turn the term off.

## Install

1. Start a store and export `DMN_STORE_URL` in the environment Claude Code runs in.
2. Run `dmn install`. It adds four command hooks to `~/.claude/settings.json` (under
   `$CLAUDE_CONFIG_DIR` when that is set, or the file given with `--settings <path>`): `SessionStart` and `UserPromptSubmit` inject memories,
   `PostToolUse` may surface an intrusive thought, `Stop` retains the last turns and counts
   cited memories. Running it again changes nothing; other hooks and keys are kept.
3. Restart Claude Code.

`dmn hook` uses `bun:sqlite`, so the `dmn` binary starts with `#!/usr/bin/env bun` and Bun must be
on the `PATH` of Claude Code. The library export (`@hyperlab.sh/dmn`) still loads under Node.

A missing `DMN_STORE_URL` exits `dmn hook user-prompt` with status 2 (Claude Code then discards
the prompt, so the message is seen). Every other hook exits 1, which Claude Code does not treat as
a block.

A memory counts as used only when the assistant cites its `[m:<id>]` marker. Turns that are
protocol traffic, or that hold a token, a key or a `.env` assignment, are never retained.

## Forgetting

Memories that are never used should stop surfacing without being lost. `dmn sweep` computes each
memory's base-level activation from its use count (creation counts as the first use) and its age,
and marks dormant every memory below `dormancyFloor` that carries none of the `protectedTags`.
Recall skips dormant memories. Nothing is deleted from the store; dormancy is dmn's own
bookkeeping in `state.sqlite`.

```sh
dmn sweep                  # sweep the generic bank and every bank in `organizations`
dmn sweep --bank org-lab   # only the given bank(s); repeatable
dmn sweep --dry-run        # report what would go dormant, write nothing
dmn sweep --revive <id>    # clear a memory's dormancy
```

- **Floor**: `dormancyFloor` (default `-2.0`). With the default decay, an unused memory crosses it
  after roughly nine days (about 220 hours).
- **Banks**: by default `generic` and the bank of each organization in `organizations`. Banks
  that exist only because a cue took its organization from the GitHub owner of `origin` are not
  swept by default; name them with `--bank org-<owner>`.
- **Protected tags**: a memory below the floor with a tag in `protectedTags` is kept and listed as
  protected in the output.
- **Revive**: `--revive` cannot be combined with `--dry-run` or `--bank`. It clears dormancy
  once. A revived memory that is still below the floor and has not been used is marked dormant
  again by the next sweep; a cited use (or a lower `dormancyFloor`) keeps it.
- A memory with no usable creation date is counted but never marked.
