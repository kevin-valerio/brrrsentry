import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import OpenAI, { APIUserAbortError } from "openai";

import {
  buildAutoJudgePrompt,
  buildCampaignPlanPrompt,
  buildTargetDiscoveryPrompt,
} from "./prompts.js";
import {
  hydrateDiscoveredTargets,
  type DiscoveredTargetDraft,
} from "./discovery.js";
import { runExecFile, tryExecFile } from "./process.js";
import type {
  AppConfig,
  CampaignPlan,
  CandidateTarget,
  DiscoveryResult,
  FuzzMode,
  RepositoryDiscoveryContext,
  ScopeMode,
} from "./types.js";

interface ModelProgressCallbacks {
  onReasoningSummary?: (summary: string) => void;
}

export interface AutoJudgeResult {
  verdict: "real_bug" | "false_positive" | "unclear";
  root_cause: "target" | "harness" | "environment" | "unknown";
  reason: string;
  fixed_harness_source?: string;
}
function createClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

function parseJsonObject<T>(text: string): T {
  return JSON.parse(text) as T;
}

const execFileAsync = promisify(execFile);

type ResponseLike = {
  output_text?: unknown;
  output?: unknown;
};

function extractOutputText(response: ResponseLike): string | undefined {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return undefined;
  }

  const chunks: string[] = [];

  for (const item of response.output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const itemType = (item as { type?: unknown }).type;
    if (itemType !== "message") {
      continue;
    }

    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const partType = (part as { type?: unknown }).type;
      if (partType !== "output_text") {
        continue;
      }

      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        chunks.push(text);
      }
    }
  }

  return chunks.length > 0 ? chunks.join("") : undefined;
}

async function createJsonResponse<T>(
  config: AppConfig,
  input: string,
  callbacks?: ModelProgressCallbacks,
): Promise<T> {
  const client = createClient();
  const stream = client.responses.stream({
    store: false,
    model: config.model,
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto",
    },
    instructions:
      "Return valid JSON. The word JSON is present on purpose. Do not add markdown fences.",
    input,
    text: {
      format: {
        type: "json_object",
      },
    },
  });

  let reasoningSummary = "";

  const streamTimeoutMs = 10 * 60 * 1000;
  const streamTimeout = setTimeout(() => stream.abort(), streamTimeoutMs);

  try {
    for await (const event of stream) {
      if (event.type === "response.reasoning_summary_text.delta") {
        reasoningSummary += event.delta;
        callbacks?.onReasoningSummary?.(reasoningSummary);
        continue;
      }

      if (event.type === "response.reasoning_summary_text.done") {
        reasoningSummary = event.text;
        callbacks?.onReasoningSummary?.(reasoningSummary);
      }
    }

    const response = await stream.finalResponse();
    const outputText = extractOutputText(response as ResponseLike);
    if (!outputText) {
      throw new Error("model returned no output text");
    }
    return parseJsonObject<T>(outputText);
  } catch (error) {
    if (error instanceof APIUserAbortError) {
      const seconds = Math.round(streamTimeoutMs / 1000);
      throw new Error(`model stream timed out after ${seconds}s`);
    }
    throw error;
  } finally {
    clearTimeout(streamTimeout);
  }
}

function resolveInsideDir(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, relativePath);

  if (resolved === root) {
    return resolved;
  }
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  return resolved;
}

function truncateText(input: string, maxChars: number): string {
  const normalized = input.replace(/\r/g, "");
  if (normalized.length <= maxChars) {
    return normalized.trim();
  }
  return `${normalized.slice(0, maxChars).trimEnd()}\n... (truncated)`;
}

function truncateLines(input: string, maxLines: number): string {
  const lines = input.replace(/\r/g, "").split("\n");
  if (lines.length <= maxLines) {
    return input.trim();
  }
  return `${lines.slice(0, maxLines).join("\n").trimEnd()}\n... (truncated)`;
}

function shouldIgnoreRepoPath(relativePath: string): boolean {
  const loweredPath = relativePath.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(\.git|\.brrrsentry|node_modules|dist|build|coverage|vendor|target|out|bin|obj)(\/|$)/.test(
    loweredPath,
  );
}

type ToolContext = {
  targetDir: string;
};

type ToolCall = {
  type?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

type FunctionTool = OpenAI.Responses.FunctionTool;

function getShellCommand(): { file: string; argsPrefix: string[] } {
  if (process.platform === "win32") {
    return { file: "cmd.exe", argsPrefix: ["/d", "/s", "/c"] };
  }
  return { file: "bash", argsPrefix: ["-lc"] };
}

function buildRepoTools(
  context: ToolContext,
): {
  tools: FunctionTool[];
  handlers: Record<string, (args: unknown) => Promise<string>>;
} {
  const listFilesTool: FunctionTool = {
    type: "function",
    name: "repo_list_files",
    description:
      "List files under the target repository. Returns relative POSIX-style paths.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description:
            "Optional subdirectory prefix (e.g. 'pkg/' or 'cmd/'). Uses forward slashes.",
        },
        suffix: {
          type: "string",
          description: "Optional filename suffix filter (e.g. '.go').",
        },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      required: ["prefix", "suffix", "offset", "limit"],
      additionalProperties: false,
    },
  };

  const readFileTool: FunctionTool = {
    type: "function",
    name: "repo_read_file",
    description:
      "Read a text file from the target repository. Use start_line/max_lines for partial reads.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        relative_path: { type: "string" },
        start_line: { type: "integer", minimum: 1, default: 1 },
        max_lines: { type: "integer", minimum: 1, maximum: 400, default: 200 },
        max_chars: { type: "integer", minimum: 200, maximum: 20000, default: 8000 },
      },
      required: ["relative_path", "start_line", "max_lines", "max_chars"],
      additionalProperties: false,
    },
  };

  const searchTool: FunctionTool = {
    type: "function",
    name: "repo_search",
    description:
      "Search inside the target repository (ripgrep). By default it is fixed-string search; set regex=true to use regex mode.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        glob: {
          type: "string",
          description: "Optional ripgrep glob (e.g. '*.go' or '**/*.md').",
        },
        regex: { type: "boolean", default: false },
        max_lines: { type: "integer", minimum: 1, maximum: 400, default: 120 },
      },
      required: ["query", "glob", "regex", "max_lines"],
      additionalProperties: false,
    },
  };

  const statTool: FunctionTool = {
    type: "function",
    name: "repo_stat_path",
    description:
      "Stat a path in the target repository (checks existence, file/dir).",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        relative_path: { type: "string" },
      },
      required: ["relative_path"],
      additionalProperties: false,
    },
  };

  const goTool: FunctionTool = {
    type: "function",
    name: "repo_go",
    description:
      "Run a Go command inside the target repository. Captures stdout+stderr (truncated).",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments passed to `go` (for example: ['list','-m','-json']).",
        },
        cwd_relative: {
          type: "string",
          description:
            "Optional working directory relative to the target repository (example: 'pkg/foo').",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 60000,
          default: 20000,
        },
      },
      required: ["args", "cwd_relative", "timeout_ms"],
      additionalProperties: false,
    },
  };

  const shellTool: FunctionTool = {
    type: "function",
    name: "shell_exec",
    description:
      "Run a shell command on the host machine. This is fully unrestricted (any path, any command). Returns combined stdout+stderr (truncated).",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to run." },
        cwd: {
          type: "string",
          description:
            "Working directory (absolute or relative to the current process). Empty means current working directory.",
          default: "",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 10 * 60 * 1000,
          default: 20000,
        },
      },
      required: ["command", "cwd", "timeout_ms"],
      additionalProperties: false,
    },
  };

  const tools = [listFilesTool, readFileTool, searchTool, statTool, goTool, shellTool];

  const handlers: Record<string, (args: unknown) => Promise<string>> = {
    async repo_list_files(rawArgs): Promise<string> {
      const parsed =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as { prefix?: unknown; suffix?: unknown; offset?: unknown; limit?: unknown })
          : {};

      const prefix = typeof parsed.prefix === "string" ? parsed.prefix.trim() : "";
      const suffix = typeof parsed.suffix === "string" ? parsed.suffix.trim() : "";
      const offset = typeof parsed.offset === "number" ? parsed.offset : 0;
      const limit = typeof parsed.limit === "number" ? parsed.limit : 200;

      const raw = await runExecFile("rg", ["--files"], context.targetDir);
      const allFiles = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((file) => file.replace(/\\/g, "/"))
        .filter((file) => !shouldIgnoreRepoPath(file));

      const filtered = allFiles.filter((file) => {
        if (prefix && !file.startsWith(prefix)) {
          return false;
        }
        if (suffix && !file.endsWith(suffix)) {
          return false;
        }
        return true;
      });

      const safeOffset = Math.max(0, Math.floor(offset));
      const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
      const files = filtered.slice(safeOffset, safeOffset + safeLimit);

      return JSON.stringify({
        total: filtered.length,
        offset: safeOffset,
        limit: safeLimit,
        files,
      });
    },

    async repo_read_file(rawArgs): Promise<string> {
      const parsed =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as { relative_path?: unknown; start_line?: unknown; max_lines?: unknown; max_chars?: unknown })
          : {};
      const relativePath =
        typeof parsed.relative_path === "string" ? parsed.relative_path.trim() : "";
      if (!relativePath) {
        throw new Error("relative_path is required");
      }

      const startLine = typeof parsed.start_line === "number" ? parsed.start_line : 1;
      const maxLines = typeof parsed.max_lines === "number" ? parsed.max_lines : 200;
      const maxChars = typeof parsed.max_chars === "number" ? parsed.max_chars : 8000;

      const fullPath = resolveInsideDir(context.targetDir, relativePath);
      const raw = await fs.readFile(fullPath, "utf8");
      const lines = raw.replace(/\r/g, "").split("\n");
      const startIndex = Math.max(0, Math.floor(startLine) - 1);
      const slice = lines.slice(startIndex, startIndex + Math.max(1, Math.floor(maxLines)));

      const numbered = slice.map((line, index) => `${startIndex + index + 1}: ${line}`);
      const output = [
        `FILE: ${relativePath.replace(/\\/g, "/")}`,
        `LINES: ${startIndex + 1}-${startIndex + numbered.length}`,
        "",
        ...numbered,
      ].join("\n");

      return truncateText(output, Math.max(200, Math.floor(maxChars)));
    },

    async repo_search(rawArgs): Promise<string> {
      const parsed =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as { query?: unknown; glob?: unknown; regex?: unknown; max_lines?: unknown })
          : {};
      const query = typeof parsed.query === "string" ? parsed.query : "";
      if (!query) {
        throw new Error("query is required");
      }

      const glob = typeof parsed.glob === "string" ? parsed.glob.trim() : "";
      const regex = typeof parsed.regex === "boolean" ? parsed.regex : false;
      const maxLines = typeof parsed.max_lines === "number" ? parsed.max_lines : 120;

      const args = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
      ];
      if (!regex) {
        args.push("--fixed-string");
      }
      if (glob) {
        args.push("--glob", glob);
      }
      args.push(query);

      const raw = await tryExecFile("rg", args, context.targetDir);
      if (!raw) {
        return "NO_MATCHES";
      }

      return truncateLines(raw, Math.max(1, Math.floor(maxLines)));
    },

    async repo_stat_path(rawArgs): Promise<string> {
      const parsed =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as { relative_path?: unknown })
          : {};
      const relativePath =
        typeof parsed.relative_path === "string" ? parsed.relative_path.trim() : "";
      if (!relativePath) {
        throw new Error("relative_path is required");
      }

      const fullPath = resolveInsideDir(context.targetDir, relativePath);
      try {
        const stat = await fs.stat(fullPath);
        return JSON.stringify({
          relative_path: relativePath.replace(/\\/g, "/"),
          exists: true,
          is_file: stat.isFile(),
          is_dir: stat.isDirectory(),
          size: stat.size,
          mtime_ms: stat.mtimeMs,
        });
      } catch {
        return JSON.stringify({
          relative_path: relativePath.replace(/\\/g, "/"),
          exists: false,
        });
      }
    },

    async repo_go(rawArgs): Promise<string> {
      const parsed =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as { args?: unknown; cwd_relative?: unknown; timeout_ms?: unknown })
          : {};

      const args = Array.isArray(parsed.args)
        ? parsed.args.map((value) => String(value))
        : [];
      if (args.length === 0) {
        throw new Error("args must be a non-empty array");
      }

      const cwdRelative = typeof parsed.cwd_relative === "string" ? parsed.cwd_relative.trim() : "";
      const timeoutMs = typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : 20000;

      const cwd = cwdRelative
        ? resolveInsideDir(context.targetDir, cwdRelative)
        : context.targetDir;

      try {
        const { stdout, stderr } = await execFileAsync("go", args, {
          cwd,
          timeout: Math.max(1000, Math.min(60000, Math.floor(timeoutMs))),
          maxBuffer: 4 * 1024 * 1024,
        });
        return truncateLines(`${stdout}${stderr}`, 260);
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string };
        const stdout = err.stdout ?? "";
        const stderr = err.stderr ?? "";
        const combined = [err.message, stdout, stderr].filter(Boolean).join("\n");
        return truncateLines(combined, 260);
      }
    },

    async shell_exec(rawArgs): Promise<string> {
      const parsed =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as { command?: unknown; cwd?: unknown; timeout_ms?: unknown })
          : {};

      const command = typeof parsed.command === "string" ? parsed.command.trim() : "";
      if (!command) {
        throw new Error("command is required");
      }

      const cwdRaw = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
      const cwd = cwdRaw.length > 0 ? cwdRaw : process.cwd();
      const timeoutMs = typeof parsed.timeout_ms === "number" ? parsed.timeout_ms : 20000;

      const shell = getShellCommand();

      try {
        const { stdout, stderr } = await execFileAsync(shell.file, [...shell.argsPrefix, command], {
          cwd,
          timeout: Math.max(1000, Math.min(10 * 60 * 1000, Math.floor(timeoutMs))),
          maxBuffer: 32 * 1024 * 1024,
        });
        return truncateLines(`${stdout}${stderr}`, 260);
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string };
        const stdout = err.stdout ?? "";
        const stderr = err.stderr ?? "";
        const combined = [err.message, stdout, stderr].filter(Boolean).join("\n");
        return truncateLines(combined, 260);
      }
    },
  };

  return {
    tools,
    handlers,
  };
}

async function createToolCallingJsonResponse<T>(
  config: AppConfig,
  input: string,
  toolContext: ToolContext,
  callbacks?: ModelProgressCallbacks,
): Promise<T> {
  const client = createClient();
  const { tools, handlers } = buildRepoTools(toolContext);

  const requestBase = {
    store: false,
    model: config.model,
    reasoning: {
      effort: config.reasoningEffort,
      summary: "auto",
    },
    instructions:
      "Return valid JSON. The word JSON is present on purpose. Do not add markdown fences.",
    tools,
    text: {
      format: {
        type: "json_object",
      },
    },
  } as const;

  const messages: OpenAI.Responses.ResponseInput = [{ role: "user", content: input }];

  const maxRounds = 12;
  for (let round = 0; round < maxRounds; round += 1) {
    const response = await client.responses.create({
      ...requestBase,
      input: messages,
    });

    const reasoningSummary =
      typeof (response as any)?.reasoning?.summary === "string"
        ? ((response as any).reasoning.summary as string)
        : "";
    callbacks?.onReasoningSummary?.(reasoningSummary);

    const outputText = extractOutputText(response as ResponseLike);
    const responseOutput = Array.isArray((response as any)?.output)
      ? ((response as any).output as unknown[])
      : [];

    const toolCalls = responseOutput
          .filter((item) => item && typeof item === "object")
          .map((item) => item as ToolCall)
          .filter((item) => item.type === "function_call")
      ;

    if (toolCalls.length === 0) {
      if (!outputText) {
        throw new Error("model returned no output text");
      }
      return parseJsonObject<T>(outputText);
    }

    const resolvedCalls = toolCalls
      .map((toolCall) => {
        const callId = typeof toolCall.call_id === "string" ? toolCall.call_id : "";
        const name = typeof toolCall.name === "string" ? toolCall.name : "";
        const rawArgs = typeof toolCall.arguments === "string" ? toolCall.arguments : "";

        return callId && name ? { callId, name, rawArgs } : null;
      })
      .filter((call): call is { callId: string; name: string; rawArgs: string } => call !== null);

    for (const call of resolvedCalls) {
      messages.push({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.rawArgs,
      } as OpenAI.Responses.ResponseInputItem);
    }

    for (const call of resolvedCalls) {
      const handler = handlers[call.name];
      if (!handler) {
        messages.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify({ error: `unknown tool: ${call.name}` }),
        } as OpenAI.Responses.ResponseInputItem);
        continue;
      }

      let args: unknown = {};
      if (call.rawArgs.trim().length > 0) {
        try {
          args = JSON.parse(call.rawArgs) as unknown;
        } catch (error) {
          messages.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({
              error: `failed to parse tool arguments as JSON: ${(error as Error).message}`,
            }),
          } as OpenAI.Responses.ResponseInputItem);
          continue;
        }
      }

      try {
        const output = await handler(args);
        messages.push({
          type: "function_call_output",
          call_id: call.callId,
          output,
        } as OpenAI.Responses.ResponseInputItem);
      } catch (error) {
        messages.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify({ error: (error as Error).message }),
        } as OpenAI.Responses.ResponseInputItem);
      }
    }
  }

  throw new Error(`tool-calling loop exceeded ${maxRounds} rounds`);
}

function summarizeRepositoryContext(context: RepositoryDiscoveryContext): string {
  const inventoryLines = context.inventory.map((file) => {
    const hints = file.reasons.length > 0 ? ` | hints: ${file.reasons.join(", ")}` : "";
    return `- ${file.relativePath} | path_score=${file.score}${hints}`;
  });

  const previewLines = context.previews.flatMap((preview) => {
    const parts = [
      `FILE: ${preview.relativePath}`,
      `path_score: ${preview.score}`,
    ];

    if (preview.reasons.length > 0) {
      parts.push(`path_hints: ${preview.reasons.join(", ")}`);
    }

    parts.push("preview:");
    parts.push(preview.content);
    parts.push("");

    return parts;
  });

  return [
    `Total candidate files seen locally: ${context.totalFiles}`,
    `Inventory count sent: ${context.inventory.length}`,
    `Preview count sent: ${context.previews.length}`,
    "",
    "Interesting file inventory (local path heuristic only, not final targets):",
    ...inventoryLines,
    "",
    "File previews (initial sample; you can request more files via tools):",
    ...previewLines,
  ].join("\n");
}

function summarizeTarget(target: CandidateTarget): string {
  return [
    `id: ${target.id}`,
    `language: ${target.language}`,
    `path: ${target.relativePath}`,
    `symbol: ${target.symbol}`,
    `signature: ${target.signature}`,
    `kind: ${target.kind}`,
    `score: ${target.score}`,
    `reasons: ${target.reasons.join(", ")}`,
  ].join("\n");
}

export function isOpenAIReady(config: AppConfig): boolean {
  void config;
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function discoverTargetsWithOpenAI(
  config: AppConfig,
  discoveryContext: RepositoryDiscoveryContext,
  context?: { fuzzMode?: FuzzMode; scopeMode?: ScopeMode },
  callbacks?: ModelProgressCallbacks,
): Promise<DiscoveryResult> {
  const input = buildTargetDiscoveryPrompt({
    targetDir: config.targetDir,
    fuzzMode: context?.fuzzMode,
    scopeMode: context?.scopeMode,
    repositoryContextSummary: summarizeRepositoryContext(discoveryContext),
  });

  const payload = await createToolCallingJsonResponse<{
    targets?: DiscoveredTargetDraft[];
    notes?: string[];
  }>(
    config,
    input,
    { targetDir: config.targetDir },
    callbacks,
  );

  const discovery = await hydrateDiscoveredTargets(
    config.targetDir,
    discoveryContext,
    payload.targets ?? [],
  );

  return {
    ...discovery,
    notes: [...discovery.notes, ...(payload.notes ?? [])],
  };
}

export async function buildCampaignPlanWithOpenAI(
  config: AppConfig,
  target: CandidateTarget,
  fuzzMode: FuzzMode,
  scopeMode: ScopeMode,
  callbacks?: ModelProgressCallbacks,
): Promise<Omit<CampaignPlan, "slug" | "fuzzMode" | "scopeMode" | "target">> {
  const input = buildCampaignPlanPrompt({
    targetDir: config.targetDir,
    fuzzMode,
    scopeMode,
    selectedTargetSummary: summarizeTarget(target),
  });

  const payload = await createToolCallingJsonResponse<{
    title?: string;
    oracle_strategy?: string;
    grammar_summary?: string;
    corpus_ideas?: string[];
    panic_on_candidates?: string[];
    report_expectations?: string[];
  }>(config, input, { targetDir: config.targetDir }, callbacks);

  return {
    title:
      payload.title ??
      `Differential fuzzing plan for ${target.symbol} (${target.relativePath})`,
    oracleStrategy:
      payload.oracle_strategy ??
      (scopeMode === "differential"
        ? "Start with gosentry crash/race/leak detectors. If BRRRSENTRY_ORACLE_BIN is configured, also compare acceptance/output against it."
        : "Start with gosentry crash/race/leak detectors."),
    harnessStrategy:
      "brrrsentry auto-generates a runnable Go harness with a single []byte fuzz input and compile-checks it before continuing.",
    grammarSummary:
      payload.grammar_summary ??
      "Start with byte fuzzing or a thin grammar for the input language accepted by the target.",
    corpusIdeas:
      payload.corpus_ideas ?? [
        "one tiny valid input",
        "one medium valid input",
        "one edge-case invalid input",
      ],
    panicOnCandidates: payload.panic_on_candidates ?? [],
    reportExpectations:
      payload.report_expectations ?? [
        "save real findings in FOUND_ISSUES.md",
        "save campaign notes in FUZZ.md",
      ],
  };
}

export async function draftGoHarnessWithOpenAI(
  config: AppConfig,
  input: {
    plan: CampaignPlan;
    targetFileSnippet: string;
  },
  callbacks?: ModelProgressCallbacks,
): Promise<{ harnessSource: string; notes: string[] }> {
  const target = input.plan.target;
  const importPath = target.importPath ?? "<missing_import_path>";
  const fuzzFnName = `Fuzz${input.plan.slug
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")}`;

  const prompt = [
    "Return JSON only.",
    "You are generating a runnable Go fuzz harness for gosentry.",
    "You can ask the application to fetch more repository context (list/search/read files) if you need more detail on the target types.",
    "You can also run host shell commands (shell_exec). This is fully unrestricted.",
    "Output must be a single Go _test.go file that compiles.",
    "The harness must define one fuzz target that takes a single []byte input from the fuzzer.",
    "Derive any other required arguments from that byte slice (for example with bytes.Reader, encoding/binary, or string conversions).",
    "Use only Go standard library packages unless the target repo packages are needed.",
    "Do not execute external commands except the optional BRRRSENTRY_ORACLE_BIN oracle.",
    "Do not make network calls.",
    "Do not read or write files outside the harness workspace.",
    "",
    `Required fuzz function name: ${fuzzFnName}`,
    "The harness must call the selected target entrypoint.",
    `Import the target package as: targetpkg "${importPath}".`,
    "Do not guess the import path. Use the one provided above.",
    "",
    'JSON format: {"harness_source":"...","notes":["..."]}',
    "",
    "Selected target:",
    summarizeTarget(target),
    "",
    "Go target metadata:",
    `import_path: ${target.importPath ?? "(unknown)"}`,
    `package_name: ${target.packageName ?? "(unknown)"}`,
    `is_method: ${target.hasReceiver ? "yes" : "no"}`,
    `arg_count: ${typeof target.argCount === "number" ? String(target.argCount) : "(unknown)"}`,
    "",
    "Target file snippet (may be incomplete):",
    input.targetFileSnippet.trim().length > 0 ? input.targetFileSnippet : "(empty)",
  ].join("\n");

  const payload = await createToolCallingJsonResponse<{
    harness_source?: string;
    notes?: string[];
  }>(config, prompt, { targetDir: config.targetDir }, callbacks);

  return {
    harnessSource: payload.harness_source?.trim() ?? "",
    notes: payload.notes ?? [],
  };
}

export async function repairGoHarnessWithOpenAI(
  config: AppConfig,
  input: {
    plan: CampaignPlan;
    targetFileSnippet: string;
    harnessSource: string;
    buildError: string;
  },
  callbacks?: ModelProgressCallbacks,
): Promise<{ harnessSource: string; notes: string[] }> {
  const target = input.plan.target;
  const importPath = target.importPath ?? "<missing_import_path>";
  const fuzzFnName = `Fuzz${input.plan.slug
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")}`;

  const prompt = [
    "Return JSON only.",
    "You are fixing a Go fuzz harness so it compiles.",
    "You can ask the application to fetch more repository context (list/search/read files) if you need more detail on the target types.",
    "You can also run host shell commands (shell_exec). This is fully unrestricted.",
    "You will be given the current harness source and a Go compiler error.",
    "Return the full updated Go source in harness_source.",
    "",
    `Required fuzz function name: ${fuzzFnName}`,
    `Import the target package as: targetpkg "${importPath}".`,
    "Do not guess the import path. Use the one provided above.",
    "",
    'JSON format: {"harness_source":"...","notes":["..."]}',
    "",
    "Selected target:",
    summarizeTarget(target),
    "",
    "Go target metadata:",
    `import_path: ${target.importPath ?? "(unknown)"}`,
    `package_name: ${target.packageName ?? "(unknown)"}`,
    `is_method: ${target.hasReceiver ? "yes" : "no"}`,
    `arg_count: ${typeof target.argCount === "number" ? String(target.argCount) : "(unknown)"}`,
    "",
    "Target file snippet (may be incomplete):",
    input.targetFileSnippet.trim().length > 0 ? input.targetFileSnippet : "(empty)",
    "",
    "Current harness source:",
    input.harnessSource.trim().length > 0 ? input.harnessSource : "(empty)",
    "",
    "Go build error output:",
    input.buildError.trim().length > 0 ? input.buildError : "(empty)",
  ].join("\n");

  const payload = await createToolCallingJsonResponse<{
    harness_source?: string;
    notes?: string[];
  }>(config, prompt, { targetDir: config.targetDir }, callbacks);

  return {
    harnessSource: payload.harness_source?.trim() ?? "",
    notes: payload.notes ?? [],
  };
}

export async function autoJudgeFindingWithOpenAI(
  config: AppConfig,
  input: {
    plan: CampaignPlan;
    campaignRoot: string;
    harnessPath: string;
    harnessSource: string;
    libAflOutputDir?: string;
    findings: Array<{ kind: string; path: string }>;
    runOutputTail: string;
  },
  callbacks?: ModelProgressCallbacks,
): Promise<AutoJudgeResult> {
  const findingsSummary =
    input.findings.length > 0
      ? input.findings.map((finding) => `- ${finding.kind}: ${finding.path}`).join("\n")
      : "- none";

  const prompt = buildAutoJudgePrompt({
    targetDir: config.targetDir,
    campaignRoot: input.campaignRoot,
    fuzzMode: input.plan.fuzzMode,
    scopeMode: input.plan.scopeMode,
    selectedTargetSummary: summarizeTarget(input.plan.target),
    harnessPath: input.harnessPath,
    harnessSource: input.harnessSource,
    libAflOutputDir: input.libAflOutputDir,
    findingsSummary,
    runOutputTail: input.runOutputTail,
  });

  const payload = await createJsonResponse<{
    verdict?: AutoJudgeResult["verdict"];
    root_cause?: AutoJudgeResult["root_cause"];
    reason?: string;
    fixed_harness_source?: string;
  }>(config, prompt, callbacks);

  return {
    verdict: payload.verdict ?? "unclear",
    root_cause: payload.root_cause ?? "unknown",
    reason: payload.reason ?? "No reason returned by model.",
    fixed_harness_source: payload.fixed_harness_source,
  };
}
