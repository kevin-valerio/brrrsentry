# brrrsentry

`brrrsentry` is a full-screen TUI that turns a target codebase into a gosentry
campaign workspace.

It scans the target directory for likely fuzz entrypoints, asks for fuzz mode
and scope, can use OpenAI to rank targets and draft a plan, then writes the
campaign files under `.brrrsentry/`.

It does not auto-run the real fuzzing campaign.

## Flow

1. Point `brrrsentry` at a target directory.
2. Choose a fuzz mode: `byte`, `struct-aware`, or `grammar`.
3. Choose a scope: `narrow`, `end-to-end`, or `differential`.
4. Review the discovered targets.
5. Generate a campaign workspace under `.brrrsentry/campaigns/<slug>/`.

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
| `--model <model>` | OpenAI model for ranking and planning | `gpt-5.2` |
| `--reasoning-effort <effort>` | OpenAI reasoning effort | `xhigh` |
| `--api-base-url <url>` | Override the OpenAI API base URL | unset |
| `--no-openai` | Disable model-backed ranking and planning | off |

## OpenAI

If `OPENAI_API_KEY` is set and `--no-openai` is not used, `brrrsentry` calls
the Responses API to rank discovered targets and draft the campaign plan.

Without OpenAI, the tool still runs local discovery and still writes a campaign
workspace. The difference is that ranking and planning fall back to local logic.

## gosentry

The default gosentry root is `third_party/gosentry`. Override it with
`--gosentry-path` if you want to use a different checkout.

Generated `fuzz.bash` expects a built gosentry `bin/go`.

## Local prompt material

If you keep local fuzzing prompt material, place it in `prompts/1.md`,
`prompts/2.md`, and `prompts/3.md`.

`brrrsentry` uses that material only as extra source context for OpenAI
ranking and planning. Core campaign rules still come from
`src/guidelines.ts`.
