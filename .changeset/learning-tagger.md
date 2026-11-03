---
"@hyperlab.sh/dmn": minor
---

Teach the Stop hook which kind of memory it retains: with `judge.provider: "laya"` each retained turn is classified in one batch call per turn-end and tagged `kind:turn`, `kind:learning` or `kind:decision` (new `KindJudge` capability on the judge, `judge.kindThreshold` config, default 0.5). A judge that is missing, throws or times out costs a warning on stderr only — the turn is still retained `kind:turn` — and a turn that holds a secret is never sent to the judge. In hooks each judge call — attempts, retries and waits — is now bounded by the hook's own store limit, so a 429 storm cannot outlive the hook. With the default provider `none` nothing changes.
