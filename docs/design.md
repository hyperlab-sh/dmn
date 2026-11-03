# dmn design

Status: pre-alpha. This is the reasoning behind the project, written before the code, so that
retrieval behaviour is never changed without knowing why it was that way.

## 1. The problem

A developer works across organizations (client work must never mix), projects, stacks and
roles (architect, developer, reviewer, operator), often at the same time. An agent with a
single memory store gets flooded: code-review memories while designing an architecture,
Hyperlab decisions while working for a client, 760 file-indexing prompts recorded as if the
user wrote them. The existing stores answer _what is related to this prompt?_. The question a
working memory answers is _what is useful right now, given where I am, what I am doing and what
I have learned?_

## 2. Requirements

1. **Layered recall.** Organization is a hard boundary. Project, stack, role and task type are
   soft layers. Generic learnings (tooling, practices, skills) cross every boundary.
2. **Usefulness, not relatedness.** A memory that was acted on many times outranks one that
   merely matches. A memory that was shown and ignored does not get stronger.
3. **Forgetting.** Unused, low-evidence memories fade and eventually stop surfacing. Decisions,
   corrections, identity and people are protected.
4. **Reinforcement through repetition.** Each actual use strengthens the memory; strengthening
   decays with time, so a memory used forty times months ago still beats a one-off from
   yesterday, but not forever.
5. **Intrusive thoughts.** Memories can surface on events other than prompts (a file opened, a
   test failed, a directory changed), rarely, when they are likely to matter, one at a time.
6. **Roster.** An agent in one role should know, cheaply, that another role's memory holds
   something relevant, without loading it.
7. **Measurable.** Every retrieval change is scored on replayed sessions before it ships.

## 3. Mechanism: ACT-R activation

Each memory has an activation `A = B + S + ε`.

- **Base level** `B = ln(n / (1 − d)) − d · ln(L)`, with `n` = number of _uses_ (creation
  counts as one), `L` = age, `d = 0.5`. Many uses raise it; age lowers it.
- **Spreading activation** `S = Σ_j W_j · max(0, S_max − ln(fan_j))` over the cues the current
  context shares with the memory. `fan_j` is how many memories a cue links to. A cue shared by
  thousands of memories (`org:mosaic`) spreads nothing; a specific one (`stack:marko`,
  `role:reviewer`) spreads a lot. This is the fan effect, and it is what makes "areas" work:
  the context lights up the memories specific to it, not everything it contains.
- **Noise** `ε` is logistic with scale `s = 0.25`. It is what lets a near-threshold memory
  surface sometimes rather than always or never.
- **Retrieval probability** `P = 1 / (1 + e^(−(A − τ)/s))`, `τ = −0.5` for prompt-time recall,
  higher for the intrusive path.

Two rules that the formulas do not enforce and the code must:

- **Reinforce on use, not on surfacing.** `n` increments when the agent cites the memory (id
  markers like `[m:ab12]` in its output, or the memory's content demonstrably shaped an
  action), never when it was merely injected. Otherwise the ranking becomes a feedback loop.
- **Context tuple first, prompt second.** The cue is `(organization, project, stack, role,
  task)` derived from the session plus the prompt text. Organization is a hard filter before
  any scoring; the rest are cues.

Parameter defaults come from memory-v2 (MIT) and match the ACT-R literature.

## 4. Why not an existing system as-is

| System                                                             | Takes                                                                                                                                 | Leaves                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Honcho                                                             | Peer model, observe_me/observe_others as a roster primitive                                                                           | Conclusions are low value; `include_most_frequent` floods; no use-based reinforcement; captured protocol traffic as user turns |
| OpenViking                                                         | Session commit, Agent Evolution (cases, experiences), extraction agent with read-only tools                                           | Access frequency carries no ranking weight; no context layers beyond the filesystem path                                       |
| Hindsight                                                          | LLM extraction, tags with `any/all/exact` matching, types, budgets, consolidation into mental models, recency decay, local MCP server | No spreading activation, no fan effect, no use counting, no intrusive path                                                     |
| Graphiti                                                           | Bi-temporal validity, custom ontology, `group_id`, node-distance rerankers                                                            | No decay, no reinforcement, heavy to run                                                                                       |
| memory-v2                                                          | `scoring.py`: ACT-R base level, spreading, noise, protected floor, RRF blend                                                          | Five commits; nothing else to take                                                                                             |
| Cognee / Mem0 / Letta / MemOS / Engram / MuninnDB / Prem / CogKura | Ideas (feedback weights, top-down recall)                                                                                             | No layered recall or activation dynamics worth building on                                                                     |

Conclusion: build the activation layer and the hooks; reuse Hindsight as the store now and
Graphiti as the associative substrate later. Do not write a database.

## 5. Architecture

```
Claude Code session
  │ hooks: SessionStart, UserPromptSubmit, PostToolUse, Stop
  ▼
dmn hooks ──── cue builder ───► (organization, project, stack, role, task, prompt)
  │                                      │
  │ retain turns, tagged with the cue    │ recall with hard org filter
  ▼                                      ▼
Hindsight store  ◄──── activation layer: rerank by A = B + S + ε, budget, inject
  │                        ▲
  │ use counts, timestamps │ use detection (id markers in output)
  ▼                        │
rest state: consolidation, promotion of generic learnings, role summaries (roster)
```

- **Cue builder.** Organization and project from cwd (hyper space layout, git remote), stack
  from manifests (`package.json`, `Cargo.toml`, …), role from the active skill, task type from
  the recent tool mix (edits vs reads vs test runs).
- **Retain.** Every turn is retained with the cue as tags. Protocol traffic (cross-session
  messages, Orca, file indexing from other agents) is filtered before it is written: that was
  the single largest source of junk in Honcho.
- **Recall.** Hard filter on organization (generic memories carry no organization tag). Store
  returns candidates by similarity; the activation layer reranks with `B + S`, draws `ε`,
  applies the budget, injects with id markers.
- **Reinforce.** `Stop` hook scans the output for cited ids and increments their use count.
- **Forget.** A sweep marks memories dormant when `B` falls below a floor and the memory has
  no protected tag; dormant memories are excluded from recall but never deleted.
- **Intrude.** `PostToolUse` runs a cheap recall against a higher threshold with jitter and a
  cooldown; at most one memory, one line, with its id.
- **Roster.** Per-role mental models, refreshed during rest state, give each role a short
  summary of what other roles' memories cover.

## 6. Roadmap

1. **Thesis.** Hindsight + hooks + activation layer + a replay harness that scores what would
   have been injected over twenty past prompts. Ships when the harness shows the activation
   rerank beats plain similarity on those prompts.
2. **Dynamics.** Use-based reinforcement, forgetting sweep, intrusive path tuning, protected
   tags.
3. **Associative substrate.** Graphiti with an ontology (organization, project, stack, role,
   task, decision, skill, person), Hebbian edge weights from co-use, activation as a graph
   walk, validity windows for decisions that were later reversed.
4. **Rest state.** Scheduled consolidation, cross-project promotion of generic learnings (a
   learning used in two or more projects is copied to the wider scope — its organization, or
   `generic` — and the original goes dormant), role summaries and the roster: one Hindsight
   mental model per role per bank (`dmn-role-<role>`), created and refreshed by `dmn rest`;
   `dmn hook session-start` injects one line per other role inside the budget, and
   `dmn recall --role <r>` lists a role's memories on demand.

## 7. Non-goals

- A new database or vector index.
- Multiple agent personas. One agent with the right memories beats several with partitioned ones.
- Replacing project documentation. CLAUDE.md and specs stay the source of truth for rules;
  dmn remembers what happened and what worked.
