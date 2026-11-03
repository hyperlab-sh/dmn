# Replay

The replay harness measures the thesis: does activation rerank put more useful memories in the
top five than the store's own order? It replays past Claude Code sessions through recall in both
orders, writes a report to read and a judgements file to fill in, and scores the result.

## Run it

```bash
export DMN_STORE_URL=http://your-hindsight:8888    # or pass --store
dmn replay ~/.claude/projects/<project>/<session>.jsonl [more.jsonl ...] [--top 5]
```

| Option                | Meaning                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--store fake\|<url>` | `fake` seeds an in-process store from `--memories`; a URL is a real Hindsight. Falls back to `DMN_STORE_URL`.                                                                            |
| `--memories <json>`   | Memories for the fake store: `[{bank, tags, text, createdAt?}]`. Default `fixtures/replay/memories.json`, relative to the current directory, so run from a checkout; otherwise an error. |
| `--manifests <dir>`   | Directory whose `package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml` give the cue's stack.                                                                                    |
| `--out <dir>`         | Where run directories go. Default: the `replayDir` config key.                                                                                                                           |
| `--top <n>`           | List length and the `n` of precision@n. Default 5.                                                                                                                                       |

Each run writes `<out>/run-<timestamp>/report.md` and `judgements.json`. A run directory that already exists is never overwritten (exit 2): your judgements are in it, so with a fixed `DMN_NOW` pass another `--out` or remove the directory. The report records the run's `top:`, and `replay score` uses it. The harness only reads
the store; the one `retain` is the seeding of the fake store. Use counts live in a scratch state
that is deleted afterwards.

For reproducible output set `DMN_SEED` (any string, seeds the activation noise) and `DMN_NOW`
(an ISO date, the clock). Two runs with the same inputs are byte-identical.

## Judge

`report.md` shows, per prompt, the cue `(organization, project, stack, role, task)`, the first
120 characters of the prompt, and two top-5 lists: `store` (the store's own order) and
`activation` (what dmn would inject, with `A = B + S + noise` split out).

`judgements.json` has one entry per shown memory: `{prompt, id, order, useful: null}`. Open the
report next to it and set `useful` to `true` when the memory would have helped with that prompt,
`false` when not. Judge each memory on its own text; the same memory appears once per order.

## Score

```bash
dmn replay score <run-dir>
```

```
store p@5 = 0.40
activation p@5 = 0.60
judged 20/20
```

Precision@5 per order (@`top` of the run, which `score` reads from the report; `--top` overrides) is the useful memories among a prompt's first five shown, over five,
averaged over the prompts. A list shorter than five is still divided by five. Entries left at
`null` count as not useful; `judged` says how many you filled in. The command rewrites the
`## Summary` section of `report.md` with both numbers side by side (before scoring it says
`unscored`).

Read the number as a comparison on your own prompts, not an absolute: a gap of one memory per
prompt on a few dozen prompts is signal; a gap on five prompts is noise, and the activation
noise term moves ranks between runs, so judge the same run you scored.

## Known limitation: the cue is rebuilt without the filesystem

The recorded working directory may not exist on the machine running the replay, so the cue is
built from the transcript alone and `scanCueInput` is not used. There is no workspace root and no
git remote, so `organization` is always `generic` and `project` is `none`; recall therefore reads
only the `generic` bank and the `project:` tag never matches. `stack` is empty unless you pass
`--manifests`. `role` and `task` come from the slash commands, `Skill` calls and tool calls
recorded in the transcript, as live hooks do. Results on a real store are consequently
conservative for tag matching.
