import OpenAI from "openai";

import {
  buildAutoJudgePrompt,
  buildCampaignPlanPrompt,
  buildTargetRankingPrompt,
  type PromptSources,
} from "./prompts.js";
import type {
  AppConfig,
  CampaignPlan,
  CandidateTarget,
  DiscoveryResult,
  FuzzMode,
  RankedTargetResult,
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

async function createJsonResponse<T>(
  config: AppConfig,
  input: string,
  callbacks?: ModelProgressCallbacks,
): Promise<T> {
  const client = createClient();
  const stream = client.responses.stream({
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
  return parseJsonObject<T>(response.output_text);
}

function summarizeCandidates(candidates: CandidateTarget[]): string {
  return candidates
    .map((candidate) =>
      [
        `- id: ${candidate.id}`,
        `  language: ${candidate.language}`,
        `  path: ${candidate.relativePath}`,
        `  symbol: ${candidate.symbol}`,
        `  signature: ${candidate.signature}`,
        `  kind: ${candidate.kind}`,
        `  score: ${candidate.score}`,
        `  reasons: ${candidate.reasons.join(", ")}`,
      ].join("\n"),
    )
    .join("\n");
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

export async function rankTargetsWithOpenAI(
  config: AppConfig,
  discovery: DiscoveryResult,
  prompts: PromptSources,
  context?: { fuzzMode?: FuzzMode; scopeMode?: ScopeMode },
  callbacks?: ModelProgressCallbacks,
): Promise<RankedTargetResult> {
  const input = buildTargetRankingPrompt({
    targetDir: config.targetDir,
    fuzzMode: context?.fuzzMode,
    scopeMode: context?.scopeMode,
    candidatesSummary: summarizeCandidates(discovery.candidates.slice(0, 12)),
    sourcePromptText: prompts.combinedText,
  });

  const payload = await createJsonResponse<{
    recommended_ids?: string[];
    notes?: string[];
  }>(config, input, callbacks);

  return {
    recommendedIds: payload.recommended_ids ?? [],
    notes: payload.notes ?? [],
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
    harness_strategy?: string;
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
      "Manual oracle wiring is still needed. Start with an external CLI oracle or a second implementation.",
    harnessStrategy:
      payload.harness_strategy ??
      "Use a simple one-argument harness and compare acceptance decisions first.",
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
