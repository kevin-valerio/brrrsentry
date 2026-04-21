# brrrsentry

`brrrsentry` is a full-screen TUI that turns a target codebase into a gosentry
campaign workspace.

It scans the target directory for likely fuzz entrypoints, asks for fuzz mode
and scope, can use a model to rank targets and draft a plan, then writes the
campaign files under `.brrrsentry/`.

It can optionally run the generated fuzzing campaign from inside the TUI.

## Flow

1. Point `brrrsentry` at a target directory.
2. Choose a fuzz mode: `byte`, `struct-aware`, or `grammar`.
3. Choose a scope: `narrow`, `end-to-end`, or `differential`.
4. Review the discovered targets (use `+` to expand harness info).
5. Generate a campaign workspace under `.brrrsentry/campaigns/<slug>/`.
6. Run now (optional): pick cores, see the command, and watch gosentry run.

If gosentry stops with findings (crash/hang/race/leak), `brrrsentry` runs an
auto-judge pass to classify false positives. If it is a harness issue, it
applies a minimal fix to the generated harness (not the target repo code) and
auto-reruns the fuzzer once with the same cores.

## What it looks for

The static scan currently looks for candidate functions in Go, Rust, and C/C++.
It scores symbols that look useful for fuzzing, especially parse, decode,
unmarshal, verify, validate, process, and protocol-facing entrypoints.

Go targets get the best support. If the selected Go target is a simple exported
package-level function that takes one `[]byte` or `string`, `brrrsentry` writes
a runnable harness. Otherwise it writes a disabled harness template plus notes
for manual follow-up.

## Generated workspace

| Path | Purpose |
| --- | --- |
| `.brrrsentry/campaigns/<slug>/campaign.json` | Raw generated plan data |
| `.brrrsentry/campaigns/<slug>/FUZZ.md` | Campaign plan, oracle strategy, harness notes, corpus ideas |
| `.brrrsentry/campaigns/<slug>/FOUND_ISSUES.md` | Place to record real findings |
| `.brrrsentry/campaigns/<slug>/fuzz.bash` | gosentry run wrapper |
| `.brrrsentry/campaigns/<slug>/libafl.config.jsonc` | LibAFL config used by the run wrapper |
| `.brrrsentry/campaigns/<slug>/harness/` | Generated Go harness or disabled template |
| `.brrrsentry/campaigns/<slug>/grammar/grammar.json` | Grammar file for grammar mode |
| `.brrrsentry/campaigns/<slug>/corpus/` | Initial corpus notes |
| `.brrrsentry/campaigns/<slug>/reports/` | Place for replay and coverage output |

## Run

Use the TUI directly in dev mode:

```bash
npm run dev -- /path/to/target-repo
```

Or run the built CLI:

```bash
node dist/index.js /path/to/target-repo
```

## Flags

| Flag | Meaning | Default |
| --- | --- | --- |
| `--gosentry-path <path>` | Override the gosentry root path | `third_party/gosentry` |
| `--model <model>` | Model for ranking and planning | `gpt-5.2` |
| `--reasoning-effort <effort>` | Reasoning effort | `xhigh` |
| `--api-base-url <url>` | Override the API base URL | unset |

## Model calls

`OPENAI_API_KEY` is required. `brrrsentry` calls the model API to rank
discovered targets and draft the campaign plan.

While the model is ranking targets or drafting the plan, the status pane shows
a live gray model progress summary (high-level only, no raw chain-of-thought).
The selector is also briefly locked after each choice so a fast double Enter
cannot select the next step twice.

## gosentry

The default gosentry root is `third_party/gosentry`. Override it with
`--gosentry-path` if you want to use a different checkout.

Generated `fuzz.bash` expects a built gosentry `bin/go`.

## Local prompt material

If you keep local fuzzing prompt material, place it in `prompts/1.md`,
`prompts/2.md`, and `prompts/3.md`.

`brrrsentry` uses that material only as extra source context for model-backed
ranking and planning. Core campaign rules still come from
`src/guidelines.ts`.
