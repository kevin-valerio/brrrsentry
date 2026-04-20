`brrrsentry` is an agentic harness and gosentry campaign generator.

Current scope

- full-screen TUI
- target discovery
- adaptive question flow
- optional OpenAI ranking and campaign planning
- `.brrrsentry/` campaign generation
- gosentry path override support
- generated `fuzz.bash`, `FUZZ.md`, and `FOUND_ISSUES.md`

Current status

This is the first working scaffold. The goal of this pass is to make the flow real from end to end:

1. point `brrrsentry` at a target repo
2. choose fuzz mode and scope
3. discover likely targets
4. optionally rank them with OpenAI
5. generate a campaign workspace under `.brrrsentry/`

Install

```bash
npm install
```

Build

```bash
npm run build
```

Run

```bash
npm run dev -- /path/to/target-repo
```

Or after build:

```bash
node dist/index.js /path/to/target-repo
```

Useful flags

```bash
node dist/index.js /path/to/target-repo \
  --model gpt-5.2 \
  --reasoning-effort xhigh \
  --gosentry-path /absolute/path/to/gosentry \
  --api-base-url https://api.openai.com/v1
```

OpenAI behavior

- default model: `gpt-5.2`
- default reasoning effort: `xhigh`
- set `OPENAI_API_KEY` to enable model-backed ranking/planning
- use `--no-openai` to disable model calls

gosentry behavior

- default path: `third_party/gosentry`
- override with `--gosentry-path`
- generated campaigns write a `fuzz.bash` and `libafl.config.jsonc`

Repo notes

- project memory: [AGENTS.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/AGENTS.md)
- worklog: [WORKLOG.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/WORKLOG.md)
- OpenAI notes: [docs/openai-notes.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/docs/openai-notes.md)
- gosentry notes: [docs/gosentry-notes.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/docs/gosentry-notes.md)

Local prompt material

- `prompts/` is ignored by git on purpose.
- If you have local fuzzing prompt material, place it in `prompts/1.md`, `prompts/2.md`, `prompts/3.md`.
- brrrsentry uses it as optional extra context for OpenAI calls.
- Core campaign guidelines are tracked in code (`src/guidelines.ts`) and are always included in planning and in generated `FUZZ.md`.
