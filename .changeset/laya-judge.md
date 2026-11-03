---
"@hyperlab.sh/dmn": minor
---

Add a store-agnostic `Judge` interface with a Laya adapter and a fake, the `judge` config block (`LAYA_API_KEY` from the environment), and `dmn replay judge <run-dir>`, which fills `judgements.json` from the judge's calibrated probability so `dmn replay score` runs without a human.
