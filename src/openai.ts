import OpenAI, { APIUserAbortError } from "openai";

import {
  buildAutoJudgePrompt,
  buildCampaignPlanPrompt,
  buildTargetDiscoveryPrompt,
  type PromptSources,
} from "./prompts.js";
import {
  hydrateDiscoveredTargets,
  type DiscoveredTargetDraft,
} from "./discovery.js";
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
    "File previews (pick targets only from these previews):",
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
  prompts: PromptSources,
  context?: { fuzzMode?: FuzzMode; scopeMode?: ScopeMode },
  callbacks?: ModelProgressCallbacks,
): Promise<DiscoveryResult> {
  const input = buildTargetDiscoveryPrompt({
    targetDir: config.targetDir,
    fuzzMode: context?.fuzzMode,
    scopeMode: context?.scopeMode,
    repositoryContextSummary: summarizeRepositoryContext(discoveryContext),
    sourcePromptText: prompts.combinedText,
  });

  const payload = await createJsonResponse<{
    targets?: DiscoveredTargetDraft[];
    notes?: string[];
  }>(config, input, callbacks);

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
  prompts: PromptSources,
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
    sourcePromptText: prompts.combinedText,
  });

  const payload = await createJsonResponse<{
    title?: string;
    oracle_strategy?: string;
    grammar_summary?: string;
    corpus_ideas?: string[];
    panic_on_candidates?: string[];
    report_expectations?: string[];
  }>(config, input, callbacks);

  return {
    title:
      payload.title ??
      `Differential fuzzing plan for ${target.symbol} (${target.relativePath})`,
    oracleStrategy:
      payload.oracle_strategy ??
      "Start with gosentry crash/race/leak detectors. If BRRRSENTRY_ORACLE_BIN is configured, also compare acceptance/output against it.",
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
  prompts: PromptSources,
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
    ...(prompts.combinedText.trim().length > 0
      ? ["", "Local prompt source material (optional):", prompts.combinedText]
      : []),
  ].join("\n");

  const payload = await createJsonResponse<{
    harness_source?: string;
    notes?: string[];
  }>(config, prompt, callbacks);

  return {
    harnessSource: payload.harness_source?.trim() ?? "",
    notes: payload.notes ?? [],
  };
}

export async function repairGoHarnessWithOpenAI(
  config: AppConfig,
  prompts: PromptSources,
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
    ...(prompts.combinedText.trim().length > 0
      ? ["", "Local prompt source material (optional):", prompts.combinedText]
      : []),
  ].join("\n");

  const payload = await createJsonResponse<{
    harness_source?: string;
    notes?: string[];
  }>(config, prompt, callbacks);

  return {
    harnessSource: payload.harness_source?.trim() ?? "",
    notes: payload.notes ?? [],
  };
}

export async function autoJudgeFindingWithOpenAI(
  config: AppConfig,
  prompts: PromptSources,
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
    sourcePromptText: prompts.combinedText,
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
