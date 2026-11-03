---
"@hyperlab.sh/dmn": minor
---

Add the roster. `dmn rest` now creates the missing role mental models — one per role per bank,
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
