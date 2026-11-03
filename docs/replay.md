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
| `--judge fake\|laya`  | Adds a third order, `activation+judge` (below). Only this flag does: a configured provider alone makes no replay call the network. `--threshold <p>` overrides `judge.threshold`.        |

Each run writes `<out>/run-<timestamp>/report.md`, `judgements.json`, and the texts `replay judge`
needs: `memories.json` (`{id: text}` of every shown memory) and `prompts.json` (`{number: prompt}`). `prompts.json` holds the full text of your prompts, so
do not share a run directory; a prompt that contains a secret (the patterns `retain` uses) is
left out of it and is never judged. A run directory that
already exists is never overwritten (exit 2, checked before the replay starts): your judgements
are in it, so with a fixed `DMN_NOW` pass another `--out` or remove the directory. The report
records the run's `top:`, and `replay score` uses it. The harness only reads the store; the one
`retain` is the seeding of the fake store. Use counts live in a scratch state that is deleted
afterwards.

For reproducible output set `DMN_SEED` (any string, seeds the activation noise) and `DMN_NOW`
(an ISO date, the clock). Two runs with the same inputs are byte-identical.

## Judge by hand

`report.md` shows, per prompt, the cue `(organization, project, stack, role, task)`, the first
120 characters of the prompt, and two top-5 lists: `store` (the store's own order) and
`activation` (what dmn would inject, with `A = B + S + noise` split out).

`judgements.json` has one entry per shown memory: `{prompt, id, order, useful: null}`. Open the
report next to it and set `useful` to `true` when the memory would have helped with that prompt,
`false` when not. Judge each memory on its own text; the same memory appears once per order.

## Judge with Laya

`dmn replay judge <run-dir> [--threshold <p>] [--judge fake|laya]` fills `judgements.json` without
a human. For every shown memory it asks a judge whether the memory would have helped with its
prompt, stores the calibrated probability as `judge: {useful, level}` (P(true) in 0..1 and an
expected level 0..3: useless, background, helpful, decisive), and sets `useful` to
`probability >= threshold`. A memory shown in both orders of a prompt is judged once. Entries
the judge did not answer stay `null`. `report.md` gains `P(useful)=0.xx` after each id, and
`dmn replay score` then runs unchanged. The command prints `judged N/M`.

```bash
export LAYA_API_KEY=...                  # environment only; never written to config or the run
dmn replay judge <run-dir> --judge laya  # or set "judge": {"provider": "laya"} in config.json
dmn replay judge <run-dir> --judge fake  # keyword overlap, offline, for dry runs
```

- **What is sent.** To `https://api.laya.studio/v1/systemone/batch` (`judge.baseUrl` overrides):
  the prompt text and the memory text (cut to 1,500 characters), and two questions. No ids, tags,
  working directories or organization names. The service's documentation states inputs are not
  stored; check it before pointing this at private prompts.
- **Cost.** Billed per input token (`usage.input_tokens` in the response); each memory is one
  batch item carrying the prompt and the memory, so a run costs about
  `shown memories x (prompt + memory tokens)`. Requests are batched 64 at a time; 429 and 503 are
  retried up to five attempts, waiting for `Retry-After`. A memory that holds a secret is not sent.
- **Threshold.** The default `0.5` is only a start: the service's checkpoints need per-task
  calibration. Probes separate unrelated memories from useful ones cleanly and useful from
  same-project background only partly. The raw probability is stored beside `useful`, and an
  entry that already has one is not judged again: `--threshold` rewrites `useful` from the stored
  probabilities with no calls and no cost.
- **Interrupted runs.** Answers are saved after each prompt. If the service fails part-way (a
  timeout, an exhausted balance), the command prints `judged N/M` and the error, exits 1, and
  running it again judges only what is missing.
- **Older runs.** A run made before this command has no `memories.json`; `judge` exits 2 naming
  the file. Make a new run.
- **Local model later.** The model behind the service is open weights (ModernBERT-large,
  Apache-2.0); `judge.baseUrl` lets a local server answer the same API.

## The judge gate: a third order

`dmn replay … --judge fake|laya` runs the activation list through the same gate the hooks use
(one judge call per prompt, candidates below `judge.threshold` dropped, unanswered ones kept),
then takes the top `n`. `report.md` gains an `activation+judge:` list per prompt, and
`judgements.json` gains entries with `order: "activation+judge"` whose `judge: {useful, level}`
is already filled, so `replay judge` has nothing left to ask for them. The `store` and `activation`
lists are unchanged by the flag. Use `fake` offline, `laya` for the real gate.

Read the third row with care: its entries are labelled by the judge that filtered them, so under
the same judge and threshold `activation+judge` is an upper bound by construction (close to 1;
only unanswered or secret items and short lists lower it). It is comparable with the other rows
only when their labels come from a human, or from a different judge or threshold
(`replay judge --threshold` relabels it).

## Score

```bash
dmn replay score <run-dir>
```

```
store p@5 = 0.40
activation p@5 = 0.60
judged 20/20
```

Precision@n, where n is the run's `top` (recorded in the report; `--top` overrides): useful
memories among a prompt's first n shown, over n, averaged over the prompts. A shorter list is
still divided by n. Entries left at `null` count as not useful; `judged` says how many you
filled in. The command rewrites the `## Summary` section of `report.md` with both numbers side
by side (before scoring it says `unscored`). A run made with `--judge` also prints, and writes, an
`activation+judge p@n` row; runs without one score as before. That row is an upper bound under the
same judge and threshold (see above), not a gain.

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
