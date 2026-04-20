import fs from "node:fs/promises";
import path from "node:path";

import { formatGuidelinesForPrompt } from "./guidelines.js";

export interface PromptSources {
  sourceFiles: string[];
  combinedText: string;
}

export async function loadPromptSources(repoRoot: string): Promise<PromptSources> {
  const promptDir = path.join(repoRoot, "prompts");
  const defaultFiles = ["1.md", "2.md", "3.md"];
  const existingTexts: string[] = [];
  const existingFiles: string[] = [];

  for (const name of defaultFiles) {
    const fullPath = path.join(promptDir, name);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      existingTexts.push(`FILE: ${name}\n${content.trim()}`);
      existingFiles.push(fullPath);
    } catch {
      // `prompts/` is intentionally kept local-only (gitignored).
      // Missing files is expected in a fresh clone.
    }
  }

  return {
    sourceFiles: existingFiles,
    combinedText: existingTexts.join("\n\n"),
  };
}

export function buildTargetRankingPrompt(input: {
  targetDir: string;
  fuzzMode?: string;
  scopeMode?: string;
  candidatesSummary: string;
  sourcePromptText: string;
}): string {
  const chunks: string[] = [
    "Return JSON only.",
    "You are helping brrrsentry choose three strong fuzz targets for a gosentry campaign.",
    formatGuidelinesForPrompt(),
    "Pick targets that are realistic, attacker-relevant, and useful for differential or high-value fuzzing.",
    "Prefer parse, decode, unmarshal, verify, validate, state-transition, or protocol entrypoints.",
    'JSON format: {"recommended_ids":["id1","id2","id3"],"notes":["note1","note2"]}',
    "",
    `Target directory: ${input.targetDir}`,
  ];

  if (input.fuzzMode) {
    chunks.push(`Selected fuzz mode: ${input.fuzzMode}`);
  }
  if (input.scopeMode) {
    chunks.push(`Selected scope mode: ${input.scopeMode}`);
  }

  chunks.push("");
  chunks.push("Candidate targets:");
  chunks.push(input.candidatesSummary);

  if (input.sourcePromptText.trim().length > 0) {
    chunks.push("");
    chunks.push("Local prompt source material (optional):");
    chunks.push(input.sourcePromptText);
  }

  return chunks.join("\n");
}

export function buildCampaignPlanPrompt(input: {
  targetDir: string;
  fuzzMode: string;
  scopeMode: string;
  selectedTargetSummary: string;
  sourcePromptText: string;
}): string {
  return [
    "Return JSON only.",
    "You are helping brrrsentry create a gosentry fuzzing campaign plan.",
    "Use the source fuzzing prompts below as source material, not as something to repeat.",
    "The plan must be concrete, security-oriented, and realistic.",
    "Focus on differential fuzzing when possible, but stay honest if the oracle needs manual wiring.",
    formatGuidelinesForPrompt(),
    'JSON format: {"title":"...","oracle_strategy":"...","harness_strategy":"...","grammar_summary":"...","corpus_ideas":["..."],"panic_on_candidates":["..."],"report_expectations":["..."]}',
    "",
    `Target directory: ${input.targetDir}`,
    `Selected fuzz mode: ${input.fuzzMode}`,
    `Selected scope mode: ${input.scopeMode}`,
    "",
    "Selected target:",
    input.selectedTargetSummary,
    ...(input.sourcePromptText.trim().length > 0
      ? ["", "Local prompt source material (optional):", input.sourcePromptText]
      : []),
  ].join("\n");
}
