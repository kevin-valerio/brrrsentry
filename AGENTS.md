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

Important implementation notes

- Use official OpenAI docs before changing the OpenAI integration
- Use `third_party/gosentry/README.md` and the USE_LIBAFL.md doc before changing gosentry integration. This contains all the documentation required about what gosentry is and how it works.
- gosentry supports panic-on-call, race/leak catching, grammar fuzzing, and coverage replay. See below.
- In the TUI, format long fields (especially target `reasons`) as multi-line bullets, not one long line
- In the TUI, the `Stdout` pane merges status + model thinking + gosentry output (full width during Run; `s` stops fuzzing)
- Model tool-calling includes `shell_exec` which can run any command on the host machine

Full control pass

TODO
