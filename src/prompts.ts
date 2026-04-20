import fs from "node:fs/promises";
import path from "node:path";

export interface PromptSources {
  sourceFiles: string[];
  combinedText: string;
}

export async function loadPromptSources(repoRoot: string): Promise<PromptSources> {
  const promptDir = path.join(repoRoot, "prompts");
  const sourceFiles = ["1.md", "2.md", "3.md"];
  const texts = await Promise.all(
    sourceFiles.map(async (name) => {
      const fullPath = path.join(promptDir, name);
      const content = await fs.readFile(fullPath, "utf8");
      return `FILE: ${name}\n${content.trim()}`;
    }),
  );

  return {
    sourceFiles: sourceFiles.map((name) => path.join(promptDir, name)),
    combinedText: texts.join("\n\n"),
  };
}

export function buildTargetRankingPrompt(input: {
  targetDir: string;
  candidatesSummary: string;
  sourcePromptText: string;
}): string {
  return [
    "Return JSON only.",
    "You are helping brrrsentry choose three strong fuzz targets for a GoSentry campaign.",
    "Use the source fuzzing prompts below only as source material.",
    "Pick targets that are realistic, attacker-relevant, and useful for differential or high-value fuzzing.",
    "Prefer parse, decode, unmarshal, verify, validate, state-transition, or protocol entrypoints.",
    'JSON format: {"recommended_ids":["id1","id2","id3"],"notes":["note1","note2"]}',
    "",
    `Target directory: ${input.targetDir}`,
    "",
    "Candidate targets:",
    input.candidatesSummary,
    "",
    "Source prompt material:",
    input.sourcePromptText,
  ].join("\n");
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
    "You are helping brrrsentry create a GoSentry fuzzing campaign plan.",
    "Use the source fuzzing prompts below as source material, not as something to repeat.",
    "The plan must be concrete, security-oriented, and realistic.",
    "Focus on differential fuzzing when possible, but stay honest if the oracle needs manual wiring.",
    'JSON format: {"title":"...","oracle_strategy":"...","harness_strategy":"...","grammar_summary":"...","corpus_ideas":["..."],"panic_on_candidates":["..."],"report_expectations":["..."]}',
    "",
    `Target directory: ${input.targetDir}`,
    `Selected fuzz mode: ${input.fuzzMode}`,
    `Selected scope mode: ${input.scopeMode}`,
    "",
    "Selected target:",
    input.selectedTargetSummary,
    "",
    "Source prompt material:",
    input.sourcePromptText,
  ].join("\n");
}

