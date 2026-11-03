# Configuration

dmn reads its settings from environment variables and from an optional `config.json`. Anything
that must be configured for dmn to work has no default: when it is missing the command exits
with status 2 and names it.

## Environment

| Variable          | Required | Meaning                                                                                                                   |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DMN_STORE_URL`   | yes      | Base URL of the memory store (a Hindsight server), or `fake:` for a throwaway in-memory store used by tests and dry runs. |
| `XDG_CONFIG_HOME` | no       | Holds `dmn/config.json`. Falls back to `~/.config`.                                                                       |
| `XDG_STATE_HOME`  | no       | Holds `dmn/state.sqlite` (use counts, dormancy). Falls back to `~/.local/state`.                                          |
| `XDG_DATA_HOME`   | no       | Holds `dmn/replay/`. Falls back to `~/.local/share`.                                                                      |

## `config.json`

Located at `$XDG_CONFIG_HOME/dmn/config.json`. Every key is optional.

| Key                  | Default                                        | Meaning                                                                 |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `budgetTokens`       | `600`                                          | Token budget of one injection (one token per four characters).          |
| `topK`               | `10`                                           | Candidates fetched per bank before reranking.                           |
| `promptThreshold`    | `-0.5`                                         | Reserved for prompt-time filtering by activation.                       |
| `intrusionThreshold` | `0.5`                                          | Reserved for the intrusive path.                                        |
| `intrusionCooldown`  | `5`                                            | Reserved for the intrusive path.                                        |
| `dormancyFloor`      | `-2.0`                                         | Base-level activation below which a memory may go dormant.              |
| `protectedTags`      | `decision`, `correction`, `identity`, `person` | Tags that keep a memory from going dormant.                             |
| `organizations`      | `{}`                                           | Maps the directory a hyper space sits under to an organization (below). |
| `storeTimeoutMs`     | `2000`                                         | Per-request limit for recall, so a hung store cannot stall a prompt.    |
| `retainTimeoutMs`    | `60000`                                        | Limit for retain, which waits on fact extraction.                       |
| `fanCacheSeconds`    | `300`                                          | How long tag counts are cached.                                         |
| `replayDir`          | `$XDG_DATA_HOME/dmn/replay`                    | Where replay runs are written.                                          |
| `activation`         | ACT-R defaults                                 | Overrides for the activation parameters.                                |

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

## Install

1. Start a store and export `DMN_STORE_URL` in the environment Claude Code runs in.
2. Run `dmn install`. It adds four command hooks to `~/.claude/settings.json` (under
   `$CLAUDE_CONFIG_DIR` when that is set, or the file given with `--settings <path>`): `SessionStart` and `UserPromptSubmit` inject memories,
   `PostToolUse` is reserved for the intrusive path, `Stop` retains the last turns and counts
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
  after roughly five months.
- **Protected tags**: a memory below the floor with a tag in `protectedTags` is kept and listed as
  protected in the output.
- **Revive**: clears dormancy once. A revived memory that is still below the floor and has not been
  used is marked dormant again by the next sweep; a cited use (or a higher floor) keeps it.
- A memory with no usable creation date is counted but never marked.
