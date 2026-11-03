# Contributing to dmn

Thanks for helping. dmn is early; the fastest way to help is to break it on a real session and
report what it recalled, forgot or injected wrongly.

## Reporting bugs and ideas

- Bugs: [open a bug report](https://github.com/hyperlab-sh/dmn/issues/new?template=bug_report.yml).
  For a bad recall, include the cue (cwd, active skill, task) and the memory involved.
- Ideas: [open a feature request](https://github.com/hyperlab-sh/dmn/issues/new?template=feature_request.yml).
- Questions: [GitHub Discussions](https://github.com/hyperlab-sh/dmn/discussions).
- Security: see [SECURITY.md](SECURITY.md). Never open a public issue for a leak.

## Development setup

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
git clone git@github.com:hyperlab-sh/dmn.git
cd dmn
bun install          # also installs the git hooks (lefthook)
bun run lint         # biome
bun run typecheck    # tsc --noEmit
bun test             # bun's test runner
bun run build        # tsup → dist/
```

Run only the tests your change touches while iterating (`bun test src/activation`); CI runs
the full suite.

## Code style

- TypeScript, ESM, Bun. Biome formats and lints (tabs, 100 columns); the pre-commit hook runs it.
- Full words in identifiers: `memory`, not `mem`; `activation`, not `act`.
- Read [docs/design.md](docs/design.md) before changing retrieval, scoring or hooks: the
  behaviour is modelled on human memory on purpose, and the reasons are written down there.

## Pull requests

- Branch from `main`; one topic per PR.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(recall): …`, `fix(hooks): …`); the commit-msg hook checks the format.
- Add a changeset for user-facing changes: `bun run changeset`.
- CI must be green: lint, typecheck, build, publint, tests.
- A maintainer reviews within a few days. Small, well-described PRs merge fastest.
