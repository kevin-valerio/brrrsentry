This file is memory for the `brrrsentry` project.

Project goal

`brrrsentry` is an agentic fuzzing application built around gosentry.
It should help a user go from:

1. choosing a target directory
2. answering adaptive fuzzing questions in a full-screen TUI
3. discovering good fuzz targets
4. generating a campaign workspace under `.brrrsentry/`
5. generating harness, grammar, corpus, and campaign notes
6. asking before the real fuzzing run starts

Current product decisions

- Project name is `brrrsentry`
- Main stack is TypeScript + Node.js
- UI is a full-screen TUI
- OpenAI is enabled by default
- No offline mode (OPENAI_API_KEY required)
- Default model is `gpt-5.2`
- Default reasoning effort is `xhigh`
- CLI flags must be able to override model, reasoning, and gosentry path
- Generated artifacts must live inside the target repo under `.brrrsentry/`
- gosentry is vendored as a git submodule, but runtime must also allow a path override
- The app must ask before starting a real fuzzing campaign
- We want mixed-language differential fuzzing plans from day one

Important implementation notes

- Use official OpenAI docs before changing the OpenAI integration
- Prefer the official OpenAI docs MCP server when working on OpenAI integration:
  `https://developers.openai.com/mcp`
- Use `third_party/gosentry/README.md` and `third_party/gosentry/misc/gosentry/nautilus/prompt.md` before changing gosentry integration
- Grammar mode in gosentry works best with a single `[]byte` or `string` fuzz input
- gosentry supports panic-on-call, race/leak catching, grammar fuzzing, and coverage replay
- In the TUI, format long fields (especially target `reasons`) as multi-line bullets, not one long line
- In the TUI, the `Stdout` pane merges status + model thinking + gosentry output (full width during Run; `s` stops fuzzing)
- Model tool-calling includes `shell_exec` which can run any command on the host machine

Repository map

- `src/` contains the TypeScript application
- `docs/` contains project notes and tool decisions
- `third_party/gosentry/` is the gosentry submodule

Near-term focus

- Keep the first version thin but real
- Prefer generating honest templates over fake “magic” harnesses
- Only list targets that brrrsentry can auto-wire into a runnable harness (no custom harness wiring yet)

Control pass (manual smoke test)

Goal: after any code change, run this once to make sure the full TUI flow still works end-to-end.

1. Create a tiny Go target repo (example):

```bash
TARGET_DIR=/tmp/brrrsentry-smoke-target
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cat >"$TARGET_DIR/go.mod" <<'EOF'
module example.com/brrrsentrysmoke

go 1.23
EOF
cat >"$TARGET_DIR/smoke.go" <<'EOF'
package brrrsentrysmoke

import (
	"encoding/binary"
	"errors"
)

func DecodePacket(data []byte) ([]byte, error) {
	if len(data) < 4 {
		return nil, errors.New("short header")
	}
	n := int(binary.BigEndian.Uint32(data[:4]))
	if n < 0 || n > 1_000_000 {
		return nil, errors.New("invalid length")
	}
	if len(data[4:]) < n {
		return nil, errors.New("short payload")
	}
	payload := make([]byte, n)
	copy(payload, data[4:4+n])
	return payload, nil
}
EOF
```

2. Run the TUI:

```bash
npm run dev -- "$TARGET_DIR"
```

3. In the TUI:

- Mode: Byte fuzzing
- Scope: Narrow scope
- Target: select the recommended target
- Review: Generate campaign files
- Result: Done

4. Verify output:

- The target repo now has `.brrrsentry/campaigns/<slug>/`
- `FUZZ.md` and the `harness/` folder exist inside that campaign directory
