# dmn — agent instructions

Default Mode Network: human-like memory for coding agents. A thin layer (activation scoring,
Claude Code hooks, replay harness) over existing memory stores. Read `docs/design.md` before
touching retrieval, scoring or hooks; the behaviour is deliberate and the reasons are there.

## Commands

```bash
bun install            # deps + git hooks (lefthook)
bun run lint           # biome check .
bun run typecheck      # tsc --noEmit
bun test <path>        # run only affected tests while iterating
bun run build          # tsup → dist/ (index + cli)
bun run lint:package   # publint
bun run changeset      # add a changeset for user-facing changes
```

## Layout

- `src/index.ts` — public API (package export `.`)
- `src/cli/index.ts` — the `dmn` binary
- `src/activation/` — ACT-R activation, reinforcement, forgetting (store-agnostic)
- `docs/design.md` — requirements, mechanisms, survey of other systems, architecture, roadmap

## Conventions

- Bun, TypeScript, ESM. Biome formats (tabs, 100 cols). No npm.
- Full words in identifiers (`memory` not `mem`, `activation` not `act`).
- Conventional Commits with detailed bodies. No AI attribution or session trailers in commits or PRs.
- Every `package.json` export has a matching `tsup` entry and source file; `publint` checks it.
- Never set defaults for environment variables that must be configured; throw if missing.
- Nothing dmn remembers may contain a secret. Treat any path that could leak one as a security bug.
