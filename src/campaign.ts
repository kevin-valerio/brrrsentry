import fs from "node:fs/promises";
import path from "node:path";

import type {
  AppConfig,
  CampaignPlan,
  CandidateTarget,
  GeneratedCampaign,
} from "./types.js";
import { formatGuidelinesForFuzzDoc } from "./guidelines.js";

function toKebabCase(input: string): string {
  return input
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

function toPascalCase(input: string): string {
  return input
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

export function createFallbackPlan(
  target: CandidateTarget,
  fuzzMode: CampaignPlan["fuzzMode"],
  scopeMode: CampaignPlan["scopeMode"],
): CampaignPlan {
  const slug = toKebabCase(`${target.symbol}-${fuzzMode}-${scopeMode}`);

  return {
    slug,
    title: `${target.symbol} fuzz campaign`,
    fuzzMode,
    scopeMode,
    target,
    oracleStrategy:
      scopeMode === "differential"
        ? "Compare target acceptance decisions against an external oracle CLI wired through BRRRSENTRY_ORACLE_BIN."
        : "Use target crashes, panics, hangs, and gosentry detectors as the first oracle.",
    harnessStrategy:
      "Auto-generate a runnable Go harness for the selected target, compile-check it, and auto-fix it from compiler errors.",
    grammarSummary:
      fuzzMode === "grammar"
        ? "Generate a grammar that matches the real input language of the target."
        : "Grammar is optional for this target; start from a diverse seed corpus.",
    corpusIdeas: [
      "tiny valid sample",
      "medium valid sample",
      "edge-case invalid sample",
      "deeply nested sample if the format allows it",
    ],
    panicOnCandidates: [],
    reportExpectations: [
      "record real target bugs in FOUND_ISSUES.md",
      "record campaign choices and notes in FUZZ.md",
      "save coverage replay output under reports/",
    ],
  };
}

export function canAutoWireGoHarness(target: CandidateTarget): boolean {
  const fuzzInputIndex = target.fuzzInputArgIndex;
  const fuzzInputKind = target.fuzzInputKind;
  const contextIndex = target.contextArgIndex;

  return (
    target.language === "go" &&
    target.hasReceiver === false &&
    Boolean(target.importPath) &&
    Boolean(target.packageName) &&
    target.isExported === true &&
    (fuzzInputKind === "bytes" || fuzzInputKind === "string") &&
    typeof fuzzInputIndex === "number" &&
    (target.argCount === 1
      ? fuzzInputIndex === 0
      : target.argCount === 2
        ? typeof contextIndex === "number" &&
          (contextIndex === 0 || contextIndex === 1) &&
          (fuzzInputIndex === 0 || fuzzInputIndex === 1) &&
          contextIndex !== fuzzInputIndex
        : false)
  );
}

function normalizeGoModPath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

function buildGoMod(params: {
  plan: CampaignPlan;
  moduleName?: string;
  moduleRoot?: string;
  harnessDir: string;
}): string {
  if (!params.moduleName || !params.moduleRoot) {
    return "module brrrsentry/generated\n\ngo 1.23\n";
  }

  const relativeReplace = normalizeGoModPath(
    path.relative(params.harnessDir, params.moduleRoot) || ".",
  );

  return [
    `module brrrsentry/${params.plan.slug}`,
    "",
    "go 1.23",
    "",
    `require ${params.moduleName} v0.0.0`,
    `replace ${params.moduleName} => ${relativeReplace}`,
    "",
  ].join("\n");
}

export function buildReadyGoHarness(plan: CampaignPlan): string {
  const target = plan.target;
  if (!canAutoWireGoHarness(target)) {
    throw new Error(`Target cannot be wired into a ready-made Go harness: ${target.symbol}`);
  }

  const isDifferential = plan.scopeMode === "differential";
  const inputExpr = target.fuzzInputKind === "bytes" ? "data" : "string(data)";
  const functionName = `Fuzz${toPascalCase(plan.slug)}`;
  const needsContext = target.argCount === 2;
  const args =
    needsContext && target.contextArgIndex === 0
      ? `context.Background(), ${inputExpr}`
      : needsContext
        ? `${inputExpr}, context.Background()`
        : inputExpr;

  const oracleImports = isDifferential
    ? ['  "bytes"', '  "os"', '  "os/exec"']
    : [];

  return [
    "package fuzzcampaign",
    "",
    "import (",
    ...(needsContext ? ['  "context"'] : []),
    ...oracleImports,
    '  "reflect"',
    '  "testing"',
    "",
    `  targetpkg "${target.importPath}"`,
    ")",
    "",
    `func ${functionName}(f *testing.F) {`,
    '  f.Add([]byte("{}"))',
    '  f.Add([]byte("[]"))',
    "",
    "  f.Fuzz(func(t *testing.T, data []byte) {",
    ...(isDifferential
      ? [
          `    accepted, valueText := callTarget(targetpkg.${target.symbol}, ${args})`,
          "    if oracleConfigured() {",
          "      oracleAccepted, oracleOutput := runOracleCLI(t, data)",
          "",
          "      if accepted != oracleAccepted {",
          '        t.Fatalf("acceptance mismatch: target=%v oracle=%v input=%q", accepted, oracleAccepted, data)',
          "      }",
          "",
          '      if valueText != "" && oracleOutput != "" && valueText != oracleOutput {',
          '        t.Fatalf("output mismatch: target=%q oracle=%q input=%q", valueText, oracleOutput, data)',
          "      }",
          "    }",
        ]
      : [`    _, _ = callTarget(targetpkg.${target.symbol}, ${args})`]),
    "  })",
    "}",
    "",
    "func callTarget(fn any, args ...any) (bool, string) {",
    "  values := make([]reflect.Value, 0, len(args))",
    "  for _, arg := range args {",
    "    values = append(values, reflect.ValueOf(arg))",
    "  }",
    "  results := reflect.ValueOf(fn).Call(values)",
    "  accepted := true",
    '  valueText := ""',
    "",
    "  for _, result := range results {",
    "    value := result.Interface()",
    "    if err, ok := value.(error); ok && err != nil {",
    "      accepted = false",
    "      continue",
    "    }",
    "    switch typed := value.(type) {",
    "    case []byte:",
    "      valueText = string(typed)",
    "    case string:",
    "      valueText = typed",
    "    }",
    "  }",
    "",
    "  return accepted, valueText",
    "}",
    "",
    ...(isDifferential
      ? [
          "func runOracleCLI(t *testing.T, data []byte) (bool, string) {",
          '  oracleBin := os.Getenv("BRRRSENTRY_ORACLE_BIN")',
          '  if oracleBin == "" {',
          '    return false, ""',
          "  }",
          "",
          "  cmd := exec.Command(oracleBin)",
          "  cmd.Stdin = bytes.NewReader(data)",
          "  output, err := cmd.CombinedOutput()",
          "  if err != nil {",
          "    return false, string(output)",
          "  }",
          "  return true, string(output)",
          "}",
          "",
          "func oracleConfigured() bool {",
          '  return os.Getenv("BRRRSENTRY_ORACLE_BIN") != ""',
          "}",
          "",
        ]
      : []),
  ].join("\n");
}

function buildGrammarJson(plan: CampaignPlan): string {
  if (plan.fuzzMode !== "grammar") {
    return '[]\n';
  }

  return JSON.stringify(
    [
      ["Input", "{Value}"],
      ["Value", "sample"],
      ["Value", "sample-{Value}"],
    ],
    null,
    2,
  );
}

function buildFuzzDoc(plan: CampaignPlan): string {
  return [
    `Campaign: ${plan.title}`,
    "",
    `Slug: ${plan.slug}`,
    `Target: ${plan.target.symbol}`,
    `Path: ${plan.target.relativePath}`,
    `Signature: ${plan.target.signature}`,
    `Fuzz mode: ${plan.fuzzMode}`,
    `Scope mode: ${plan.scopeMode}`,
    "",
    formatGuidelinesForFuzzDoc().trimEnd(),
    "",
    "Oracle strategy",
    "",
    plan.oracleStrategy,
    "",
    "Harness strategy",
    "",
    plan.harnessStrategy,
    "",
    "Grammar summary",
    "",
    plan.grammarSummary,
    "",
    "Corpus ideas",
    "",
    ...plan.corpusIdeas.map((idea) => `- ${idea}`),
    "",
    "panic-on candidates",
    "",
    ...(plan.panicOnCandidates.length > 0
      ? plan.panicOnCandidates.map((candidate) => `- ${candidate}`)
      : ["- none selected yet"]),
    "",
    "Report expectations",
    "",
    ...plan.reportExpectations.map((expectation) => `- ${expectation}`),
    "",
  ].join("\n");
}

function buildIssuesDoc(): string {
  return [
    "Real target issues found by the fuzzing campaign go here.",
    "",
    "Use one section per issue with:",
    "",
    "- input or reproducer path",
    "- bug type",
    "- impact",
    "- root cause",
    "- fix status",
    "",
  ].join("\n");
}

function buildLibAflConfig(): string {
  return [
    "{",
    '  "cores": "0",',
    '  "exec_timeout_ms": 1000,',
    '  "catch_hangs": true,',
    '  "hang_timeout_ms": 10000,',
    '  "hang_confirm_runs": 3,',
    '  "stop_all_fuzzers_on_panic": true,',
    '  "go_maxprocs_single": true,',
    '  "power_schedule": "fast",',
    '  "git_recency_alpha": 2.0,',
    '  "corpus_cache_size": 4096,',
    '  "initial_generated_inputs": 8,',
    '  "initial_input_max_len": 32,',
    '  "tui_monitor": false,',
    '  "debug_output": null,',
    '  "nautilus_max_len": 64,',
    '  "nautilus_cmplog_i2s": true',
    "}",
    "",
  ].join("\n");
}

function buildFuzzScript(
  config: AppConfig,
  plan: CampaignPlan,
  harnessFileName: string,
): string {
  const fuzzTarget = `Fuzz${toPascalCase(plan.slug)}`;
  const grammarFlag =
    plan.fuzzMode === "grammar"
      ? '  cmd+=(--use-grammar --grammar "$CAMPAIGN_ROOT/grammar/grammar.json")\n'
      : "";

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'CAMPAIGN_ROOT="$SCRIPT_DIR"',
    'HARNESS_DIR="$CAMPAIGN_ROOT/harness"',
    `GOSENTRY_ROOT="\${GOSENTRY_ROOT:-${config.gosentryPath}}"`,
    'GOSENTRY_BIN="${GOSENTRY_ROOT}/bin/go"',
    'CORES="${CORES:-0}"',
    "",
    'if [[ ! -x "$GOSENTRY_BIN" ]]; then',
    '  echo "gosentry binary not found at $GOSENTRY_BIN"',
    '  echo "Build it first: (cd \\"$GOSENTRY_ROOT/src\\" && ./make.bash)"',
    "  exit 1",
    "fi",
    "",
    `if [[ ! -f "$HARNESS_DIR/${harnessFileName}" ]]; then`,
    '  echo "Runnable harness file is missing."',
    '  echo "Read FUZZ.md and the harness notes first."',
    "  exit 1",
    "fi",
    "",
    'TEMP_LIBAFL_CONFIG="$(mktemp)"',
    'trap \'rm -f "$TEMP_LIBAFL_CONFIG"\' EXIT',
    'sed "s/\\"cores\\": \\"0\\"/\\"cores\\": \\"${CORES}\\"/" "$CAMPAIGN_ROOT/libafl.config.jsonc" > "$TEMP_LIBAFL_CONFIG"',
    "",
    'cd "$HARNESS_DIR"',
    'cmd=("$GOSENTRY_BIN" test "-fuzz=' + fuzzTarget + '" --focus-on-new-code=false --catch-races=true --catch-leaks=true "--libafl-config=$TEMP_LIBAFL_CONFIG")',
    grammarFlag.trimEnd(),
    'cmd+=("./...")',
    "",
    'printf "Running: "',
    'printf "%q " "${cmd[@]}"',
    'printf "\\n"',
    '"${cmd[@]}"',
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function writeCampaign(
  config: AppConfig,
  plan: CampaignPlan,
  module?: { moduleName?: string; moduleRoot?: string },
  harnessSource?: string,
): Promise<GeneratedCampaign> {
  const campaignRoot = path.join(
    config.targetDir,
    ".brrrsentry",
    "campaigns",
    plan.slug,
  );
  const harnessDir = path.join(campaignRoot, "harness");
  const corpusDir = path.join(campaignRoot, "corpus");
  const grammarDir = path.join(campaignRoot, "grammar");
  const reportsDir = path.join(campaignRoot, "reports");

  await fs.mkdir(harnessDir, { recursive: true });
  await fs.mkdir(corpusDir, { recursive: true });
  await fs.mkdir(grammarDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const harnessFileName = `${toPascalCase(plan.slug)}_test.go`;
  const harnessPath = path.join(harnessDir, harnessFileName);
  const resolvedHarnessSource =
    harnessSource ?? (canAutoWireGoHarness(plan.target) ? buildReadyGoHarness(plan) : null);
  if (!resolvedHarnessSource) {
    throw new Error(`Harness source is missing for target: ${plan.target.symbol}`);
  }

  await fs.writeFile(
    path.join(harnessDir, "go.mod"),
    buildGoMod({
      plan,
      moduleName: module?.moduleName,
      moduleRoot: module?.moduleRoot,
      harnessDir,
    }),
  );
  await fs.writeFile(harnessPath, resolvedHarnessSource);
  await fs.writeFile(path.join(grammarDir, "grammar.json"), buildGrammarJson(plan));
  await fs.writeFile(path.join(corpusDir, "README.md"), plan.corpusIdeas.join("\n"));
  await fs.writeFile(path.join(campaignRoot, "campaign.json"), JSON.stringify(plan, null, 2));
  await fs.writeFile(path.join(campaignRoot, "FUZZ.md"), buildFuzzDoc(plan));
  await fs.writeFile(path.join(campaignRoot, "FOUND_ISSUES.md"), buildIssuesDoc());
  await fs.writeFile(path.join(campaignRoot, "libafl.config.jsonc"), buildLibAflConfig());
  await fs.writeFile(
    path.join(campaignRoot, "fuzz.bash"),
    buildFuzzScript(config, plan, harnessFileName),
    { mode: 0o755 },
  );

  return {
    rootDir: campaignRoot,
    fuzzDocPath: path.join(campaignRoot, "FUZZ.md"),
    issuesPath: path.join(campaignRoot, "FOUND_ISSUES.md"),
    fuzzScriptPath: path.join(campaignRoot, "fuzz.bash"),
    harnessPath,
  };
}
