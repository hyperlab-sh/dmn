# dmn — Default Mode Network

> Human-like memory for coding agents: layered recall, forgetting, reinforcement and intrusive thoughts.

[![CI](https://img.shields.io/github/actions/workflow/status/hyperlab-sh/dmn/ci.yml?branch=main&label=CI)](https://github.com/hyperlab-sh/dmn/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hyperlab.sh/dmn)](https://www.npmjs.com/package/@hyperlab.sh/dmn)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Status: pre-alpha.** Hooks and `dmn install` work against a Hindsight store; the rest of what
this README describes is still to come. [docs/design.md](docs/design.md) has the reasoning,
[docs/configuration.md](docs/configuration.md) lists the settings and the install steps, and
[docs/replay.md](docs/replay.md) describes the replay harness that measures it on past sessions.

## Why

Agent memory systems mostly answer "what is related to this prompt?". A working developer needs
the question a human brain answers instead: _what would be useful right now, given what I am
doing, where I am doing it, and what I have learned before?_ You do not think about code when
recalling a chord; you may remember fixing a similar bug on another project, but you do not get
every project listed. Things you never use fade. Things you repeat stick. Sometimes a memory just
shows up.

The brain network behind that behaviour, mind-wandering, autobiographical recall, replay during
rest and modelling what other minds know, is the **default mode network**. dmn is that, for agents.

## What it does

- **Layered recall.** Memories carry the context they were learned in (organization, project,
  stack, role, task type). Retrieval filters on the current context first, so one client's
  memories never surface on another's work, while generic learnings (tooling, practices, skills)
  cross over.
- **Useful, not just related.** Relevance is reranked, then weighted by _activation_: how often a
  memory was actually used and how recently (ACT-R base level), plus how strongly the current
  context points at it (spreading activation with the fan effect, so a tag shared by everything
  spreads nothing).
- **Reinforcement and forgetting.** A memory the agent acts on gets stronger; one that is surfaced
  and ignored does not. Unused, low-evidence memories go dormant. Decisions and corrections are
  protected.
- **Intrusive thoughts.** On events, not only prompts (a file opened, a test failed, a directory
  changed), a cheap recall runs against a high threshold with a little noise. At most one memory,
  briefly, when it is likely to matter.
- **Rest-state work.** Consolidation, cross-project promotion of generic learnings, and per-role
  summaries so a lead knows what the reviewer's memory covers.

## How it will be built

dmn is a thin layer over existing stores, not a new database:

- **Store:** [Hindsight](https://github.com/vectorize-io/hindsight) for extraction, tag-scoped
  recall, consolidation and mental models; a graph substrate
  ([Graphiti](https://github.com/getzep/graphiti)) later for associations and validity windows.
- **Activation layer:** ACT-R scoring, use-based reinforcement and forgetting, store-agnostic.
  Formulas follow Anderson's ACT-R; parameter defaults were taken from
  [memory-v2](https://github.com/Haustorium12/memory-v2) (MIT).
- **Claude Code hooks:** build the cue from the session (cwd, active skill, recent tools), inject
  within a token budget, retain turns with the cue's tags, count uses, and filter agent protocol
  traffic out of what gets remembered.
- **Harness:** replay past sessions and score what would have been injected, so every retrieval
  change is measured.

To run Hindsight locally, see [docs/hindsight.md](docs/hindsight.md).

## Roadmap

1. Prove the thesis: Hindsight + hooks + activation layer + replay harness.
2. Dynamics: use-based reinforcement, forgetting sweep, intrusive path tuning.
3. Associative substrate: ontology (organization, project, stack, role, task, decision, skill,
   person), Hebbian edge weights, activation as graph walk, validity windows.
4. Rest state: scheduled consolidation, cross-project promotion, role summaries and the roster.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Real sessions where memory got in the way are the most
useful bug reports.

## License

[MIT](LICENSE)
