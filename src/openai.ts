import OpenAI from "openai";

import {
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

function createClient(config: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: config.apiBaseUrl,
  });
}

function parseJsonObject<T>(text: string): T {
  return JSON.parse(text) as T;
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
  return config.openAIEnabled && Boolean(process.env.OPENAI_API_KEY);
}

export async function rankTargetsWithOpenAI(
  config: AppConfig,
  discovery: DiscoveryResult,
  prompts: PromptSources,
  context?: { fuzzMode?: FuzzMode; scopeMode?: ScopeMode },
): Promise<RankedTargetResult> {
  const client = createClient(config);
  const input = buildTargetRankingPrompt({
    targetDir: config.targetDir,
    fuzzMode: context?.fuzzMode,
    scopeMode: context?.scopeMode,
    candidatesSummary: summarizeCandidates(discovery.candidates.slice(0, 12)),
    sourcePromptText: prompts.combinedText,
  });

  const response = await client.responses.create({
    model: config.model,
    reasoning: { effort: config.reasoningEffort },
    instructions:
      "Return valid JSON. The word JSON is present on purpose. Do not add markdown fences.",
    input,
    text: {
      format: {
        type: "json_object",
      },
    },
  });

  const payload = parseJsonObject<{
    recommended_ids?: string[];
    notes?: string[];
  }>(response.output_text);

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
): Promise<Omit<CampaignPlan, "slug" | "fuzzMode" | "scopeMode" | "target">> {
  const client = createClient(config);
  const input = buildCampaignPlanPrompt({
    targetDir: config.targetDir,
    fuzzMode,
    scopeMode,
    selectedTargetSummary: summarizeTarget(target),
    sourcePromptText: prompts.combinedText,
  });

  const response = await client.responses.create({
    model: config.model,
    reasoning: { effort: config.reasoningEffort },
    instructions:
      "Return valid JSON. The word JSON is present on purpose. Do not add markdown fences.",
    input,
    text: {
      format: {
        type: "json_object",
      },
    },
  });

  const payload = parseJsonObject<{
    title?: string;
    oracle_strategy?: string;
    harness_strategy?: string;
    grammar_summary?: string;
    corpus_ideas?: string[];
    panic_on_candidates?: string[];
    report_expectations?: string[];
  }>(response.output_text);

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
