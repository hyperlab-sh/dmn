---
"@hyperlab.sh/dmn": minor
---

Add Claude Code hooks and `dmn install`. `dmn hook session-start|user-prompt` inject memories,
`dmn hook stop` retains the last turns (never protocol traffic or secrets) and counts memories the
assistant cited, and `dmn install` wires the hooks into Claude Code's settings idempotently.
Export `shouldRetain` and `extractUses`.
