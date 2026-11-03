---
"@hyperlab.sh/dmn": minor
---

Add Hebbian co-use. `dmn hook stop` records a co-use edge for every pair of memories the assistant
cites in one turn, and recall adds an association term: a memory associated with a highly
activated one gains activation, scaled by the new `activation.associationWeight` (default `0.5`,
`0` turns it off). `LocalState` gains `recordCoUse`, `associations` and `associationFan`;
`RankedMemory` gains `association`; `rerank` takes an optional `promptThreshold`. Breaking for
callers of `rerank`: its `state` option must now provide `associations` and `associationFan`.
