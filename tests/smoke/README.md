Smoke targets (fixtures)

This folder contains small Go modules used as stable targets for CI smoke runs.
Each target is a standalone Go module (it has its own go.mod).

Targets

| Path | Purpose | Bug? |
| --- | --- | --- |
| tests/smoke/decode-ok | Clean length-prefixed decode helper | no |
| tests/smoke/panic-bug | Panics on the default brrrsentry harness seed ("{}") | yes (panic) |
| tests/smoke/struct-bug | gosentry struct-aware fuzzing (composite input) | yes (panic) |
| tests/smoke/race-bug | Data race detector target | yes (race) |
| tests/smoke/differential-bug | Differential target + oracle CLI | yes (oracle mismatch) |
| tests/smoke/grammar-json-bug | JSON parser target for grammar fuzzing + a small JSON grammar | yes (panic) |
| tests/smoke/end-to-end-bug | Multi-step JSON event handling (end-to-end style) | yes (panic) |
