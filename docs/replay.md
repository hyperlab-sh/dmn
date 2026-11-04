# Replay

The replay harness measures the thesis: does activation rerank put more useful memories in the
top five than the store's own order? It replays past Claude Code sessions through recall in both
orders, writes a report to read and a judgements file to fill in, and scores the result.

## Run it

```bash
export DMN_STORE_URL=http://your-hindsight:8888    # or pass --store
dmn replay ~/.claude/projects/<project>/<session>.jsonl [more.jsonl ...] [--top 5]
```

| Option                           | Meaning                                                                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--store fake\|<url>`            | `fake` seeds an in-process store from `--memories`; a URL is a real Hindsight. Falls back to `DMN_STORE_URL`.                                                                            |
| `--memories <json>`              | Memories for the fake store: `[{bank, tags, text, createdAt?}]`. Default `fixtures/replay/memories.json`, relative to the current directory, so run from a checkout; otherwise an error. |
| `--manifests <dir>`              | Directory whose `package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml` give the cue's stack.                                                                                    |
| `--out <dir>`                    | Where run directories go. Default: the `replayDir` config key.                                                                                                                           |
| `--top <n>`                      | List length and the `n` of precision@n. Default 5.                                                                                                                                       |
| `--judge fake\|laya\|typesafe`   | Adds a third order, `activation+judge` (below). Only this flag does: a configured provider alone makes no replay call the network. `--threshold <p>` overrides `judge.threshold`.        |
| `--as-live`                      | Replay time instead of reading a seeded store (below). Every prompt line must carry a timestamp; a prompt without one exits 2 naming the file and index.                                 |
| `--measure-from <iso>`           | With `--as-live`: prompts before this time are retained only — seeding, never measured.                                                                                                  |
| `--uses judged\|none`            | With `--as-live`: the use signal (below). `judged` (the default) needs `--judge`; `none` records nothing, for an ablation.                                                               |
| `--max-consecutive-failures <n>` | With `--as-live`: stop the walk after `n` prompts in a row whose store calls failed (default 5; below).                                                                                  |

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
(an ISO date, the clock). Two runs with the same inputs are byte-identical. A run directory that
already exists is never overwritten (exit 2, checked before the replay starts) — with one
exception: the run a resumed as-live walk rewrites over its checkpoint (below).

## Judge by hand

`report.md` shows, per prompt, the cue `(organization, project, stack, role, task)`, the first
120 characters of the prompt, and two top-5 lists: `store` (the store's own order) and
`activation` (what dmn would inject, with `A = B + S + noise` split out).

`judgements.json` has one entry per shown memory: `{prompt, id, order, useful: null}`. Open the
report next to it and set `useful` to `true` when the memory would have helped with that prompt,
`false` when not. Judge each memory on its own text; the same memory appears once per order.

## Judge with Laya

`dmn replay judge <run-dir> [--threshold <p>] [--judge fake|laya|typesafe]` fills `judgements.json` without
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

### Judge with TypeSafe (Jev)

The same command with `--judge typesafe` (or `"judge": {"provider": "typesafe"}` in
config.json) asks TypeSafe's Jev model instead:

```bash
export TYPESAFE_API_KEY=...                    # environment only; never written to config or the run
dmn replay judge <run-dir> --judge typesafe
```

- **What is sent.** To `https://api.typesafe.ai/v1/systemone` (`judge.baseUrl` overrides): one
  request per memory, with `model: "jev-latest"`, the same state text as Laya (the prompt and
  the memory text cut to 1,500 characters) and the same two questions; a kind question sends the
  bare text. No ids, tags, working directories or organization names. The service's
  documentation states what it retains; check it before pointing this at private prompts.
- **No batch form.** The endpoint answers one state per request, so dmn sends one request per
  memory with at most 8 in flight. A request that fails — after the same five-attempt retry of
  429 and 503 honouring `Retry-After` — leaves that memory unanswered and judges the rest; a run
  where every request fails fails like Laya's would.
- **Cost.** Each request is billed on its `usage.input_tokens` (about one prompt-plus-memory
  per memory), and Jev reads 32k tokens per question — the reason to prefer it on long prompts,
  where a judge that truncates the state never sees the memory it is judging.

## The judge gate: a third order

`dmn replay … --judge fake|laya|typesafe` runs the activation list through the same gate the hooks use
(one judge call per prompt, candidates below `judge.threshold` dropped, unanswered ones kept),
then takes the top `n`. `report.md` gains an `activation+judge:` list per prompt, and
`judgements.json` gains entries with `order: "activation+judge"` whose `judge: {useful, level}`
is already filled, so `replay judge` has nothing left to ask for them. The `store` and `activation`
lists are unchanged by the flag. Use `fake` offline, `laya` or `typesafe` for the real gate.

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

## As-live replay

A plain run measures recall against a store seeded in one go: every memory has the same age,
no use events exist and no co-use edges do, so the two orders differ only by noise. As-live
replays the sessions the way a live install would have lived them:

```bash
export DMN_STORE_URL=http://your-hindsight:8888    # or pass --store
dmn replay --as-live --judge laya a.jsonl b.jsonl [--measure-from 2026-11-01] [--top 5]
```

The prompts of every transcript are merged and walked in timestamp order, and the clock is
set to each prompt's own time. Recall at prompt N sees only what was retained before N;
after a prompt is reported, its user and assistant turns are retained with that timestamp —
the same `retainTurns` call the Stop hook makes, secrets filtered — so the next prompt can
recall them; the sweep runs whenever the replayed calendar day (UTC) changes, and once more
after the last prompt. Use counts, co-use edges and dormancy therefore accrue in replayed
time, exactly as they would have.

- **Use signal.** `--uses judged` (the default) needs `--judge`: every memory shown at a
  prompt that the judge calls useful at `judge.threshold` counts as _used_ — a use event and
  co-use edges under the replayed clock, as a cited `[m:<id>]` marker would. In this mode the
  judge named by `--judge` is the use signal, not a third order: no `activation+judge` list is
  written. `--uses none` records nothing, for an ablation without reinforcement.
- **Seeding and measuring in one run.** `--measure-from <iso>` retains-only the prompts before
  it: they are never recalled, judged or reported. Point it at the date you installed dmn and
  the same run seeds the store from the older sessions and measures the newer ones.
- **A failed retain does not stop the walk.** When the store rejects a prompt's retain — a
  store error, a timeout, an HTTP 4xx/5xx from Hindsight — the run reports it as a warning
  (`retain failed <transcript>#<index>: <message>`) and continues with the next prompt; the
  exit code is unchanged. dmn never retries a failed retain: the retry policy is Hindsight's
  own.
- **The report.** The header gains `mode: as-live`, `uses:`, `measure-from:` and `seeded:`
  after `top:`; `dmn replay score` reads `top:` as before and ignores the rest. Judging and
  scoring work on the run exactly as on a plain one.
- **Where the cue's organization and project come from.** The recorded working directory may
  not exist on the machine running the walk, so the cue is built from the transcript alone and
  the path stands in for the scan. The project is the first of three rules the path offers: the
  segment before a `worktrees` segment when the path has one
  (`/work/lab/some-space/worktrees/main` → `some-space`); else the segment right after the
  first directory named in the `organizations` mapping, which anchors the project in the space
  it opens (`/work/lab/some-space/notes/briefs` with `lab` mapped → `some-space`); else the
  last segment (`/home/u/src/core` → `core`). The organization is the `organizations` mapping
  applied to the segment before that project segment (`lab` → `hyperlab` when mapped), else
  `generic`. An empty or root cwd keeps `project: none`. Retained memories therefore land in
  the bank — and carry the `project:` tag — of the project the transcript was recorded in, and
  a live prompt outside any repository gets the same answer: the scan runs first and this path
  rule is only its fallback.

With `--store fake` an as-live run starts from an empty in-process store — the walk builds
the store itself, and seeding the dated fixture memories would recall later content at
earlier prompts; pass `--memories <json>` to start from a chosen set anyway. The local state
is still a scratch directory, deleted afterwards. For reproducibility set
`DMN_SEED` and `DMN_NOW` as usual: `DMN_NOW` names the run directory only — every recorded
age, use and dormancy decision inside the walk comes from the prompts' own timestamps.

## Resuming a walk

A full walk over months of transcripts re-extracts every prompt; a measurement built in steps
should not pay that twice. An as-live run therefore keeps a checkpoint in its `--out`
directory — `checkpoint.json`, rewritten after every prompt: which prompts were seeded and
which measured (keyed `<basename>:<index>`), the measured entries so far, and the settings the
walk was made with. Run the same command again with the same `--out` and the walk resumes:

- **What is skipped.** Every checkpointed prompt is never recalled, judged or retained again;
  the rest walk in timestamp order as usual, and the report is written over all entries of
  every run into that `--out`, merged in timestamp order. The header's `seeded:` is the total
  over all runs. A run directory the resumed walk writes already exists is rewritten — the one
  exception to "never overwritten"; an `--out` whose run directory exists but holds no checkpoint
  (a plain run's, say) still exits 2.
- **What must match.** The checkpoint's `--measure-from`, `--uses` and `--top` are what it was
  made with; resuming with anything else is a usage error (exit 2) before a single turn is
  retained. Adding transcripts is the point: a longer walk extends the previous one's store
  instead of rebuilding it. Point `--store` at the same Hindsight as the first run.
- **Out-of-order prompts.** A resumed walk that retains a prompt older than the last
  checkpointed prompt gets one `warnings` line per such prompt:
  `out of order: <transcript>#<index> (<iso>) is older than the checkpoint (<iso>); measurements
  before it did not see it`. The store still gets the prompt's turns; the warning says the
  earlier measurements were not as-live for that memory.
- **What does not carry over.** Use counts, co-use edges and dormancy live in the run's scratch
  state, deleted afterwards: a resumed walk starts them empty and records no use for
  checkpointed prompts, so activation numbers in the resumed run are computed without the
  earlier runs' reinforcement.
- **Progress.** The walk prints one line to stderr every 25 walked prompts and when a
  transcript completes:
  `progress <done>/<total> prompts, <seeded> seeded, <measured> measured, <failed> failed,
  <mm:ss> elapsed` — every count of the current invocation, `<total>` its remaining walk.
  Warnings also appear in the report under `warnings:` next to the header.

## When the store stops answering

The walk distinguishes a bad prompt from a dead store:

- **A failed retain** (a store error, a timeout, an HTTP 4xx/5xx from Hindsight) is reported
  as a warning — `retain failed <transcript>#<index>: <message>` — and the walk continues with
  the next prompt; later prompts recall everything retained before the failure. dmn never
  retries a failed retain: the retry policy is Hindsight's own.
- **A failed recall** (a store error, a timeout) costs that prompt's measurement — one warning,
  `recall failed <transcript>#<index>: <message>`, no entry for the prompt — and nothing else:
  the prompt's turns are still retained, so the next prompt recalls them. A single failed
  recall between successful prompts does not stop the walk.
- **The stop.** A prompt whose retain or recall failed counts as failed; after
  `--max-consecutive-failures <n>` (default 5) failed prompts in a row the walk stops — a
  depleted or dead provider costs a few prompts, not hours of judge credit. The checkpoint and
  a report of everything measured so far are written, the exit code is 1, and one stderr line
  names the count and the last error: `stopped after <n> consecutive failures: <message>`.
  Recalls that succeed between failing prompts do not reset the count: a store that only
  retains badly still stops the walk. Fix the store and rerun the same command: the walk
  resumes from the checkpoint. A prompt whose recall failed is not checkpointed as measured,
  so a resumed run tries it again.

## Seed a store from history

`dmn backfill` is the seeding half of as-live, for a user installing dmn with a history:

```bash
export DMN_STORE_URL=http://your-hindsight:8888
dmn backfill ~/.claude/projects/<project>/<session>.jsonl [more.jsonl ...] [--max-turns 40] [--dry]
```

Each prompt's user and assistant turns are retained through the same filter the Stop hook
applies (protocol traffic and secrets never make it), stamped with the prompt's recorded time —
backfilled memories carry their content time, never the ingest time — under the document id
`<file>:<index>`, so re-running replaces documents instead of duplicating them. `--max-turns`
limits the prompts taken per transcript (default 40; the lead measured with 25). `--dry`
prints one line per transcript — `prompts=`, `retained=` and the skipped-reason counts — and
retains nothing; it needs no store. Without `--dry` the run prints `total retained N` and
needs `DMN_STORE_URL`. A retain the store rejects — a store error, a timeout, an HTTP 4xx/5xx
from Hindsight — does not stop the run: the transcript's line counts it (`failed=N` beside
`retained=`), `total retained` counts only successful retains, and the exit code is 1 only
when nothing was retained at all and at least one retain failed. Failed retains are not
retried: the retry policy is Hindsight's own. A transcript prompt without a timestamp exits 2
naming the file and the prompt's index, before anything is retained.

## Known limitation: the cue is rebuilt without the filesystem

The recorded working directory may not exist on the machine running the replay, so the cue is
built from the transcript alone and `scanCueInput` is not used: there is no workspace root and
no git remote. Organization and project then come from the recorded path itself, by the rule
the as-live section above describes, so the `project:` tag matches the project the transcript
was recorded in; `stack` is empty unless you pass `--manifests`, which is what keeps recall on
a real store conservative for tag matching. `role` and `task` come from the slash commands,
`Skill` calls and tool calls recorded in the transcript, as live hooks do.
