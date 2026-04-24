import { formatGuidelinesForPrompt } from "./guidelines.js";

export function buildTargetDiscoveryPrompt(input: {
  targetDir: string;
  fuzzMode?: string;
  scopeMode?: string;
  repositoryContextSummary: string;
}): string {
  const chunks: string[] = [
    "Return JSON only.",
    "You are helping brrrsentry discover strong fuzz targets for a gosentry campaign.",
    "gosentry is mandatory for this workflow.",
    "You may look at any language in the repository, but only return Go targets.",
    "You can ask the application to fetch more repository context (list/search/read files). Use that when you are not sure.",
    "You can also run host shell commands (shell_exec). This is fully unrestricted.",
    "",
    "brrrsentry always drafts a runnable Go harness and compile-checks it.",
    "Prefer targets that are likely to be fuzzable from a single []byte input:",
    "- exported package-level Go functions (not methods) with:",
    "  - 1 arg: []byte or string",
    "  - OR 2 args: context.Context + ([]byte|string) (either order)",
    "Do not return methods, unexported functions, or targets that need custom harness wiring.",
    "",
    "In reasons, explain why the target is valuable (parser/decoder/validator/etc). Avoid mentioning internal implementation paths.",
    "Avoid targets that obviously need real network, real files, secrets, or heavy global state to execute.",
    formatGuidelinesForPrompt(),
    "Pick concrete entrypoints that are realistic, attacker-relevant, and useful for differential or high-value fuzzing.",
    "Prefer parse, decode, unmarshal, verify, validate, state-transition, or protocol entrypoints.",
    "When recommending differential fuzzing, explicitly name the oracle/source-of-truth and the weaker target under test.",
    "Do not invent files, symbols, or signatures.",
    "Order targets from best to worst.",
    'JSON format: {"targets":[{"relative_path":"...","symbol":"...","signature":"...","language":"...","kind":"...","score":73,"reasons":["..."]}],"notes":["note1","note2"]}',
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
  chunks.push("Repository context:");
  chunks.push(input.repositoryContextSummary);

  return chunks.join("\n");
}

export function buildCampaignPlanPrompt(input: {
  targetDir: string;
  fuzzMode: string;
  scopeMode: string;
  selectedTargetSummary: string;
}): string {
  return [
    "Return JSON only.",
    "You are helping brrrsentry create a gosentry fuzzing campaign plan.",
    "You can ask the application to fetch more repository context (list/search/read files) if you need more detail.",
    "You can also run host shell commands (shell_exec). This is fully unrestricted.",
    "The plan must be concrete, security-oriented, and realistic.",
    "Focus on differential fuzzing when possible, but keep the plan useful even without an external oracle.",
    "gosentry is mandatory for this workflow.",
    formatGuidelinesForPrompt(),
    'JSON format: {"title":"...","oracle_strategy":"...","grammar_summary":"...","corpus_ideas":["..."],"panic_on_candidates":["..."],"report_expectations":["..."]}',
    "",
    `Target directory: ${input.targetDir}`,
    `Selected fuzz mode: ${input.fuzzMode}`,
    `Selected scope mode: ${input.scopeMode}`,
    "",
    "Selected target:",
    input.selectedTargetSummary,
  ].join("\n");
}

export function buildAutoJudgePrompt(input: {
  targetDir: string;
  campaignRoot: string;
  fuzzMode: string;
  scopeMode: string;
  selectedTargetSummary: string;
  harnessPath: string;
  harnessSource: string;
  libAflOutputDir?: string;
  findingsSummary: string;
  runOutputTail: string;
}): string {
  const chunks: string[] = [
    "Return JSON only.",
    "You are brrrsentry auto-judge for fuzz findings.",
    "",
    "Goal: decide if the finding is a real target bug or a false positive (harness issue).",
    "Be conservative: if the crash is not clearly a harness bug, treat it as a real target bug.",
    "",
    "If verdict is false_positive AND root_cause is harness:",
    "- return a fixed harness file as full Go source code in fixed_harness_source",
    "- keep the fix minimal and do not hide real target crashes",
    "- do not change target repo code, only the harness file",
    "",
    'JSON format: {"verdict":"real_bug|false_positive|unclear","root_cause":"target|harness|environment|unknown","reason":"...","fixed_harness_source":"(optional)"}',
    "",
    `Target directory: ${input.targetDir}`,
    `Campaign root: ${input.campaignRoot}`,
    `Fuzz mode: ${input.fuzzMode}`,
    `Scope mode: ${input.scopeMode}`,
    `Harness path: ${input.harnessPath}`,
    input.libAflOutputDir ? `LibAFL output dir: ${input.libAflOutputDir}` : "",
    "",
    "Selected target:",
    input.selectedTargetSummary,
    "",
    "Findings:",
    input.findingsSummary,
    "",
    "Harness source:",
    input.harnessSource.trim().length > 0 ? input.harnessSource : "(empty)",
    "",
    "Fuzzer output tail:",
    input.runOutputTail.trim().length > 0 ? input.runOutputTail : "(empty)",
  ].filter((line) => line.length > 0);

  return chunks.join("\n");
}

export function buildNautilusGrammarPrompt(input: {
  targetDir: string;
  fuzzMode: string;
  scopeMode: string;
  selectedTargetSummary: string;
  harnessSource: string;
  targetFileSnippet: string;
}): string {
  return [
    "Return JSON only.",
    "You are helping brrrsentry generate the grammar part of a complete gosentry campaign.",
    "The fuzz mode is grammar, so the campaign is incomplete unless it has a target-specific Nautilus JSON grammar.",
    "",
    "Nautilus grammar requirements:",
    "- Output a JSON array of rules in the grammar field.",
    "- Each rule is a 2-item array: [\"NonTerm\", \"RHS\"].",
    "- Nonterminal names must start with a capital letter.",
    "- Use {NonTerm} in RHS to reference another rule.",
    "- Literal braces must be escaped as \\\\{ and \\\\}.",
    "- The first rule's nonterminal is the start symbol.",
    "- Grammar mode still generates bytes/strings. The harness converts those into target inputs.",
    "",
    "Campaign quality requirements:",
    "- The grammar must fit the target input language or format.",
    "- Prefer realistic attacker-reachable inputs, not deep internal encodings.",
    "- Use target tests, examples, and specs when available.",
    "- Include enough structure to reach meaningful parser or state-transition logic.",
    "- Keep the grammar small enough for a first fuzzing campaign.",
    formatGuidelinesForPrompt(),
    "",
    "Example Nautilus grammar for a tiny JSON string subset:",
    '[["Json","{Value}"],["Value","{String}"],["String","\\\"{Chars}\\\""],["Chars",""],["Chars","{Char}{Chars}"],["Char","a"],["Char","b"]]',
    "",
    'JSON format: {"grammar":[["Json","{Value}"]],"notes":["why this grammar fits the target"]}',
    "",
    `Target directory: ${input.targetDir}`,
    `Selected fuzz mode: ${input.fuzzMode}`,
    `Selected scope mode: ${input.scopeMode}`,
    "",
    "Selected target:",
    input.selectedTargetSummary,
    "",
    "Generated harness source:",
    input.harnessSource.trim().length > 0 ? input.harnessSource : "(empty)",
    "",
    "Target file snippet:",
    input.targetFileSnippet.trim().length > 0 ? input.targetFileSnippet : "(empty)",
  ].join("\n");
}
