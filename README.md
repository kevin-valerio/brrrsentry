# brrrsentry

`brrrsentry` is a full-screen TUI that turns a target codebase into a gosentry
campaign workspace.

It builds a local repository context, asks for fuzz mode and scope, uses a
model to discover likely fuzz entrypoints, then writes the campaign files under
`.brrrsentry/`.

It can optionally run the generated fuzzing campaign from inside the TUI.

## Flow

1. Point `brrrsentry` at a target directory.
2. Choose a fuzz mode: `byte` or `grammar`.
3. Choose a scope: `narrow`, `end-to-end`, or `differential`.
4. Review the discovered targets.
5. Generate a campaign workspace under `.brrrsentry/campaigns/<slug>/`.
6. Run now (optional): pick cores, see the command, and watch gosentry run.
   If gosentry is not built yet, brrrsentry will build it first (runs `<gosentry-path>/src/make.bash`).

If gosentry stops with findings (crash/hang/race/leak), `brrrsentry` runs an
auto-judge pass to classify false positives. If it is a harness issue, it
applies a minimal fix to the generated harness (not the target repo code) and
auto-reruns the fuzzer once with the same cores.

## What it looks for

Target discovery is agentic now. `brrrsentry` builds a local file inventory and
source preview set, then asks the model to pick concrete fuzz targets from that
repo context.

During discovery and planning, the model can also request extra repository
context (list/search/read files) from the app.

The model can also run `shell_exec` commands. This is fully unrestricted (any
path, any command). Only use `brrrsentry` in an environment you trust.

Today `brrrsentry` only runs Go targets. It prefers targets that are easy to
run through a single `[]byte` fuzz input (or `context.Context` + `[]byte`).
Targets that need custom harness wiring are skipped for now.

Go module roots are resolved per discovered target file (closest `go.mod`
above it), so monorepos with nested Go modules are supported.

`brrrsentry` generates a ready-made harness and compile-checks it before showing
the target in the list.

In `differential` scope, the ready harness can compare against an external oracle
CLI wired through `BRRRSENTRY_ORACLE_BIN`. That oracle can be implemented in any
language (Go, Rust, C/C++, etc).

## Generated workspace

| Path | Purpose |
| --- | --- |
| `.brrrsentry/campaigns/<slug>/campaign.json` | Raw generated plan data |
| `.brrrsentry/campaigns/<slug>/FUZZ.md` | Campaign plan, oracle strategy, harness notes, corpus ideas |
| `.brrrsentry/campaigns/<slug>/FOUND_ISSUES.md` | Place to record real findings |
| `.brrrsentry/campaigns/<slug>/fuzz.bash` | gosentry run wrapper |
| `.brrrsentry/campaigns/<slug>/libafl.config.jsonc` | LibAFL config used by the run wrapper |
| `.brrrsentry/campaigns/<slug>/harness/` | Generated Go harness |
| `.brrrsentry/campaigns/<slug>/grammar/grammar.json` | Grammar file for grammar mode |
| `.brrrsentry/campaigns/<slug>/corpus/` | Initial corpus notes |
| `.brrrsentry/campaigns/<slug>/reports/` | Place for replay and coverage output |

## Run

Use the TUI directly in dev mode:

```bash
npm run dev -- /path/to/target-repo
```

In the TUI, use arrows + Enter (or single mouse click) to select.
The `Stdout` pane shows status, model thinking, and gosentry output. During a
fuzz run it expands to full width. Press `s` to stop fuzzing.

Or run the built CLI:

```bash
npm run build
node dist/index.js /path/to/target-repo
```

## Flags

| Flag | Meaning | Default |
| --- | --- | --- |
| `--gosentry-path <path>` | Override the gosentry root path | `third_party/gosentry` |
| `--model <model>` | Model for discovery and planning | `gpt-5.2` |
| `--reasoning-effort <effort>` | Reasoning effort | `xhigh` |

## Model calls

`OPENAI_API_KEY` is required. `brrrsentry` calls the model API to discover
targets, draft the campaign plan, and auto-judge fuzz findings.

Requests are sent with `store: false`, so they are not saved in the OpenAI
dashboard logs.

While the model is discovering targets or drafting the harness/plan, the Flow pane shows
high-level progress plus a reasoning summary (no raw chain-of-thought).
The selector is also briefly locked after each choice so a fast double Enter
cannot select the next step twice.

For streamed model requests, `brrrsentry` aborts a stalled stream after 10 minutes and
treats it as a model failure.

## gosentry

The default gosentry root is `third_party/gosentry`. Override it with
`--gosentry-path` if you want to use a different checkout.

Generated `fuzz.bash` expects a built gosentry `bin/go`.
When you run from inside the TUI (Run now), brrrsentry will build gosentry automatically if `bin/go` is missing.

## Local prompt material

If you keep local fuzzing prompt material, place it in `prompts/1.md`,
`prompts/2.md`, and `prompts/3.md`.

`brrrsentry` uses that material only as extra source context for model-backed
discovery and planning. Core campaign rules still come from
`src/guidelines.ts`.

Those core rules include things like: gosentry is required, use Go vs Go (or
Go vs X) harnesses, pick a clear oracle/source-of-truth for differential checks,
use tests/specs to stay realistic, and avoid admin-only/key-compromise targets.
