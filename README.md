`brrrsentry` is an agentic harness and GoSentry campaign generator.

Current scope

- full-screen TUI
- target discovery
- adaptive question flow
- optional OpenAI ranking and campaign planning
- `.brrrsentry/` campaign generation
- GoSentry path override support
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

GoSentry behavior

- default path: `third_party/gosentry`
- override with `--gosentry-path`
- generated campaigns write a `fuzz.bash` and `libafl.config.jsonc`

Repo notes

- project memory: [AGENTS.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/AGENTS.md)
- worklog: [WORKLOG.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/WORKLOG.md)
- OpenAI notes: [docs/openai-notes.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/docs/openai-notes.md)
- GoSentry notes: [docs/gosentry-notes.md](/Users/kevinvalerio/Desktop/tooling/brrrsentry/docs/gosentry-notes.md)

