This file is memory for the `brrrsentry` project.

Project goal

`brrrsentry` is an agentic fuzzing application built around gosentry.
It should help a user go from:

1. choosing a target directory
2. answering adaptive fuzzing questions in a full-screen TUI
3. discovering good fuzz targets
4. generating a campaign workspace under `.brrrsentry/`
5. generating harness, grammar (if required), corpus, and campaign notes
6. asking before the real fuzzing run starts
7. then when it runs if the app detects a bug (an LLM should monitor the output) there's an agent
   checking if that's a false positive (harness issue) or not
8. if its' a false positive it fixes the bug, and re-run, if it's a true positive it shows an alert
   bug detected

the questions are basically do the user wants a narrow harness like per-function or more end-to-end
but also does he want a byte fuzzing or structure-aware or let the app auto-decide or grammar
fuzzing

don't forget to check gosentry readme thats' important to understand how it works and how to tailor
it

Really important: the application is agentic and can execute many commmands. That means that many
goals should be achieved by sending a prompt to the model we're using, and it executes code etc, a
bit like how codex works. We just then parse the output in json and adapt the ui accordingly
we want to do agentic looping and workflows

remember keep the code simple, we don't want offline stuff, we want some agents interacting with
each others and have some kind of loops like agent to agent communication, nothing complex

Important implementation notes

- Use official OpenAI docs before changing the OpenAI integration
- Use `third_party/gosentry/README.md` and the USE_LIBAFL.md doc before changing gosentry integration. This contains all the documentation required about what gosentry is and how it works.
- gosentry supports panic-on-call, race/leak catching, grammar fuzzing, and coverage replay. See below.
- In the TUI, format long fields (especially target `reasons`) as multi-line bullets, not one long line
- In the TUI, the `Stdout` pane merges status + model thinking + gosentry output (full width during Run; `s` stops fuzzing)
- Model tool-calling includes `shell_exec` which can run any command on the host machine

Full control pass

TODO
