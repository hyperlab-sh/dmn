# Changelog

## 0.1.0

### Minor Changes

- [#17](https://github.com/hyperlab-sh/dmn/pull/17) [`8377f88`](https://github.com/hyperlab-sh/dmn/commit/8377f88c0b6ffe54269de3ca9fed7b41f690cfc8) Thanks [@svallory](https://github.com/svallory)! - As-live replay and backfill. `dmn replay --as-live` replays time instead of reading a store seeded in one go: the prompts of every transcript walk in timestamp order with the clock set to each prompt's own time, so recall at a prompt sees only what was retained before it; after a prompt is reported its turns are retained with that timestamp (the same call the Stop hook makes), the sweep runs whenever the replayed calendar day changes, and `--uses judged` (the default, needs `--judge`) counts a shown memory the judge calls useful as used — use events and co-use edges under the replayed clock. `--measure-from <iso>` retains-only the prompts before it, so one run seeds from older sessions and measures newer ones. `dmn backfill <transcripts...> [--max-turns <n>] [--dry]` is the seeding alone, for installing dmn with a history; every retained turn now carries its content time (`RetainItem.timestamp` on the wire, a record's `createdAt`), never the ingest time.

- [#6](https://github.com/hyperlab-sh/dmn/pull/6) [`9ca8d94`](https://github.com/hyperlab-sh/dmn/commit/9ca8d94c2cd65fbac18168187d4456b3b664f5f2) Thanks [@svallory](https://github.com/svallory)! - Add Claude Code hooks and `dmn install`. `dmn hook session-start|user-prompt` inject memories,
  `dmn hook stop` retains the last turns (never protocol traffic or secrets) and counts memories the
  assistant cited, and `dmn install` wires the hooks into Claude Code's settings idempotently.
  Export `shouldRetain` and `extractUses`.

- [#9](https://github.com/hyperlab-sh/dmn/pull/9) [`ac1e413`](https://github.com/hyperlab-sh/dmn/commit/ac1e413bdd0061fd7c85614cf5dfc3858756730c) Thanks [@svallory](https://github.com/svallory)! - Add Hebbian co-use. `dmn hook stop` records a co-use edge for every pair of memories the assistant
  cites in one turn, and recall adds an association term: a memory associated with a highly
  activated one gains activation, scaled by the new `activation.associationWeight` (default `0.5`,
  `0` turns it off). `LocalState` gains `recordCoUse`, `associations` and `associationFan`;
  `RankedMemory` gains `association`; `rerank` takes an optional `promptThreshold`. Breaking for
  callers of `rerank`: its `state` option must now provide `associations`.

- [#8](https://github.com/hyperlab-sh/dmn/pull/8) [`916b688`](https://github.com/hyperlab-sh/dmn/commit/916b688287b51504a4f315b00c0ca7470fc1c0ef) Thanks [@svallory](https://github.com/svallory)! - Add intrusive thoughts. After a tool call, `dmn hook post-tool` occasionally surfaces one memory
  as a single `[m:<id>] <text>` line, keyed by the tool's target, when its retrieval probability
  beats a random draw and the cooldown is over. Set `intrusionThreshold` to `null` to turn it off.

- [#10](https://github.com/hyperlab-sh/dmn/pull/10) [`9ba0ca6`](https://github.com/hyperlab-sh/dmn/commit/9ba0ca6e1111a96c33c2537d8644a9d0c5586f73) Thanks [@svallory](https://github.com/svallory)! - Add a store-agnostic `Judge` interface with a Laya adapter and a fake, the `judge` config block (`LAYA_API_KEY` from the environment), and `dmn replay judge <run-dir>`, which fills `judgements.json` from the judge's calibrated probability so `dmn replay score` runs without a human.

- [#12](https://github.com/hyperlab-sh/dmn/pull/12) [`69b6a58`](https://github.com/hyperlab-sh/dmn/commit/69b6a587fa73a9460f9d71b4be41bfe2c4b9ad05) Thanks [@svallory](https://github.com/svallory)! - Teach the Stop hook which kind of memory it retains: with `judge.provider: "laya"` each retained turn is classified in one batch call per turn-end and tagged `kind:turn`, `kind:learning` or `kind:decision` (new `KindJudge` capability on the judge, `judge.kindThreshold` config, default 0.5). A judge that is missing, throws or times out costs a warning on stderr only — the turn is still retained `kind:turn` — and a turn that holds a secret is never sent to the judge. In hooks each judge call — attempts, retries and waits — is now bounded by the hook's own store limit, so a 429 storm cannot outlive the hook. With the default provider `none` nothing changes.

- [#5](https://github.com/hyperlab-sh/dmn/pull/5) [`52febe9`](https://github.com/hyperlab-sh/dmn/commit/52febe9c3847ad145bca09e575c16ba8344dfca2) Thanks [@svallory](https://github.com/svallory)! - Add `dmn replay` and `dmn replay score`: replay past Claude Code transcripts through recall in store order and activation order, write a report and judgements skeleton, and score precision@5 per order.

- [#13](https://github.com/hyperlab-sh/dmn/pull/13) [`5816c82`](https://github.com/hyperlab-sh/dmn/commit/5816c827d2948fe45c6fda30c62ef13b9b9e3ba6) Thanks [@svallory](https://github.com/svallory)! - Add `dmn rest`: per bank it triggers the store's own consolidation and reports the memories tagged
  `kind:learning` whose use records name two or more projects — a project-tagged learning is
  proposed for its organization scope, an organization learning for the `generic` bank. `dmn rest
--apply` promotes each proposal by retaining a copy at the wider scope (`documentId
"promotion:<id>"`, `metadata.promoted_from`) and marking the original dormant; a promoted memory is
  never proposed again, and without `--apply` nothing is written. Nothing is ever deleted. Use
  records now carry the project of the session that cited them (`use_events.project`, added on open
  to existing state files); `recordUse` and `countCitedUses` take it, and the Stop hook passes the
  cue's project. `MemoryStore` gains `consolidate`. A bank whose pass fails is reported and the run
  continues; a refused promotion or a failed bank makes the exit 1, so scheduled runs can tell.

- [#14](https://github.com/hyperlab-sh/dmn/pull/14) [`9177c8e`](https://github.com/hyperlab-sh/dmn/commit/9177c8eea66ec993195af63ad41ea07d62239229) Thanks [@svallory](https://github.com/svallory)! - Add the roster. `dmn rest` now creates the missing role mental models — one per role per bank,
  `dmn-role-<role>` tagged `role:<role>`, 512 tokens, over `architect`, `developer`, `reviewer`
  and `operator` — and refreshes every one through the store, so each model summarizes what that
  role's memories in that bank cover; a refused create or refresh is a warning on stderr and the
  run continues. `dmn hook session-start` appends one `[roster:<role>] <first sentence>` line per
  other role after the memory lines, inside the same `budgetTokens`; a line that does not fit is
  dropped, and a store that cannot be read costs the lines (a warning), never the injection. The
  new `dmn recall --role <r> [--top N]` prints that role's memories (`[m:<id>]` lines, store
  order, dormant ids dropped, no activation rerank) over the cue's two banks; an unknown role
  exits 1 naming the four. `MemoryStore` gains `mentalModels`, `createMentalModel` and
  `refreshMentalModel`; dmn never edits or deletes a mental model.

### Patch Changes

- [#18](https://github.com/hyperlab-sh/dmn/pull/18) [`3c3af2d`](https://github.com/hyperlab-sh/dmn/commit/3c3af2da466d95661fb26df793405be9ef56ae8c) Thanks [@svallory](https://github.com/svallory)! - Retain failures no longer abort `dmn replay --as-live` or `dmn backfill`. In an as-live run a retain the store rejects (a store error, a timeout, an HTTP 4xx/5xx from Hindsight) is reported as a warning — `retain failed <transcript>#<index>: <message>` — and the walk continues with the next prompt; later prompts recall everything retained before the failure, and the exit code is unchanged. In `dmn backfill` the transcript's output line counts failed prompts (`failed=N` beside `retained=`), `total retained` counts only successful retains, and the run exits 1 only when nothing was retained at all and at least one retain failed. Neither command retries a failed retain: the retry policy stays Hindsight's own, whose throttling knobs (`HINDSIGHT_API_LLM_MAX_CONCURRENT`, `HINDSIGHT_API_LLM_MAX_RETRIES`, `HINDSIGHT_API_LLM_INITIAL_BACKOFF`, `HINDSIGHT_API_LLM_MAX_BACKOFF`) are now documented in `docs/hindsight.md`, alongside the fact that Anthropic's usage safeguard refuses fact extraction over Claude Code transcripts with the `claude-code` provider (`[reasoning_extraction]`), so ingesting your own Claude history needs another provider.

Generated by [Changesets](https://github.com/changesets/changesets) from the `.changeset/` entries;
do not edit by hand.
