---
"@hyperlab.sh/dmn": minor
---

Add `dmn rest`: per bank it triggers the store's own consolidation and reports the memories tagged
`kind:learning` whose use records name two or more projects — a project-tagged learning is
proposed for its organization scope, an organization learning for the `generic` bank. `dmn rest
--apply` promotes each proposal by retaining a copy at the wider scope (`documentId
"promotion:<id>"`, `metadata.promoted_from`) and marking the original dormant; a promoted memory is
never proposed again, and without `--apply` nothing is written. Nothing is ever deleted. Use
records now carry the project of the session that cited them (`use_events.project`, added on open
to existing state files); `recordUse` and `countCitedUses` take it, and the Stop hook passes the
cue's project. `MemoryStore` gains `consolidate`. A bank whose pass fails is reported and the run
continues; a refused promotion or a failed bank makes the exit 1, so scheduled runs can tell.
