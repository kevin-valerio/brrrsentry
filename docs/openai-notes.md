OpenAI notes for `brrrsentry`

Why this project uses the official `openai` Node SDK

- OpenAI provides an official TypeScript and JavaScript SDK for server-side Node.js usage
- The Responses API is the main API we want for model calls in this project
- This project already owns the local TUI, file access, and campaign generation flow, so the first version uses the official SDK directly instead of adding a larger agent framework

Relevant official docs

- Quickstart: https://developers.openai.com/api/docs/quickstart
- Libraries: https://developers.openai.com/api/docs/libraries
- Code generation: https://platform.openai.com/docs/guides/code-generation
- Responses API migration guide: https://platform.openai.com/docs/guides/migrate-to-responses
- Structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Shell tool: https://platform.openai.com/docs/guides/tools-shell
- Docs MCP: https://platform.openai.com/docs/docs-mcp

Project choices

- Default model is `gpt-5.2`
- Default reasoning effort is `xhigh`
- Model settings must be overridable by CLI
- First pass uses the Responses API
- First pass asks the model for JSON output and validates it locally

Notes on output format

- Official docs recommend structured outputs over plain JSON mode when possible
- For a thin first pass, this project keeps the request shape simple and validates returned JSON locally
- If we later tighten schemas, use `text.format` with a JSON schema or the SDK helper for structured outputs

Notes on shell and MCP

- The OpenAI shell tool exists in the Responses API
- The shell tool can run in hosted containers or through a local shell runtime
- `brrrsentry` does not need hosted shell for the first pass because it already runs locally and can inspect the target repo itself
- OpenAI exposes a public docs MCP server at `https://developers.openai.com/mcp`
- Future agents working on this repo should prefer that docs MCP for OpenAI questions

