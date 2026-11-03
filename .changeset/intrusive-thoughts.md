---
"@hyperlab.sh/dmn": minor
---

Add intrusive thoughts. After a tool call, `dmn hook post-tool` occasionally surfaces one memory
as a single `[m:<id>] <text>` line, keyed by the tool's target, when its retrieval probability
beats a random draw and the cooldown is over. Set `intrusionThreshold` to `null` to turn it off.
