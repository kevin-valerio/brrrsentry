import fs from "node:fs/promises";
import path from "node:path";

import type {
  AppConfig,
  CampaignPlan,
  CandidateTarget,
  GeneratedCampaign,
} from "./types.js";

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
        : "Use target crashes, panics, hangs, and GoSentry detectors as the first oracle.",
    harnessStrategy:
      canAutoWireGoHarness(target)
        ? "Generate a package-level Go harness for the selected function."
        : "Generate a manual harness template and campaign notes because the entrypoint is not simple enough to auto-wire safely.",
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

function canAutoWireGoHarness(target: CandidateTarget): boolean {
  return (
    target.language === "go" &&
    !target.hasReceiver &&
    Boolean(target.importPath) &&
    Boolean(target.packageName) &&
    Boolean(target.isExported) &&
    target.argCount === 1 &&
    Boolean(target.acceptsBytes || target.acceptsString)
  );
}

function buildGoMod(plan: CampaignPlan, moduleName?: string): string {
  if (!moduleName) {
    return "module brrrsentry/generated\n\ngo 1.23\n";
  }

  return [
    `module brrrsentry/${plan.slug}`,
    "",
    "go 1.23",
    "",
    `require ${moduleName} v0.0.0`,
    `replace ${moduleName} => ../../../..`,
    "",
  ].join("\n");
}

function buildReadyGoHarness(plan: CampaignPlan): string {
  const target = plan.target;
  const inputExpr = target.acceptsBytes ? "data" : "string(data)";
  const targetInputType = target.acceptsBytes ? "[]byte" : "string";
  const functionName = `Fuzz${toPascalCase(plan.slug)}`;

  return [
    "package fuzzcampaign",
    "",
    "import (",
    '  "bytes"',
    '  "os"',
    '  "os/exec"',
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
    `    accepted, valueText := callTarget(targetpkg.${target.symbol}, ${inputExpr})`,
    "    oracleAccepted, oracleOutput := runOracleCLI(t, data)",
    "",
    '    if oracleConfigured() && accepted != oracleAccepted {',
    '      t.Fatalf("acceptance mismatch: target=%v oracle=%v input=%q", accepted, oracleAccepted, data)',
    "    }",
    "",
    '    if oracleConfigured() && valueText != "" && oracleOutput != "" && valueText != oracleOutput {',
    '      t.Fatalf("output mismatch: target=%q oracle=%q input=%q", valueText, oracleOutput, data)',
    "    }",
    "  })",
    "}",
    "",
    `func callTarget(fn any, input ${targetInputType}) (bool, string) {`,
    "  results := reflect.ValueOf(fn).Call([]reflect.Value{reflect.ValueOf(input)})",
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
  ].join("\n");
}

function buildManualHarness(plan: CampaignPlan): string {
  return [
    "This target was not auto-wired into a runnable Go harness.",
    "",
    `Target: ${plan.target.symbol}`,
    `Path: ${plan.target.relativePath}`,
    `Signature: ${plan.target.signature}`,
    "",
    "Why manual follow-up is needed",
    "",
    "- the selected entrypoint is not a simple exported package-level function with one `[]byte` or `string` input",
    "- or the package import path could not be inferred safely",
    "",
    "Suggested next step",
    "",
    "- move this target into a hand-written harness",
    "- keep the campaign workspace here for grammar, corpus, reporting, and run scripts",
    "",
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
  generated: { harnessFileName: string; runnable: boolean },
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
    '  echo "GoSentry binary not found at $GOSENTRY_BIN"',
    '  echo "Build it first: (cd \\"$GOSENTRY_ROOT/src\\" && ./make.bash)"',
    "  exit 1",
    "fi",
    "",
    `if [[ ! -f "$HARNESS_DIR/${generated.harnessFileName}" ]]; then`,
    '  echo "Runnable harness file is missing."',
    '  echo "Read FUZZ.md and the harness notes first."',
    "  exit 1",
    "fi",
    "",
    generated.runnable
      ? ""
      : 'echo "This campaign only has a manual harness template right now. Read FUZZ.md first."\nexit 1',
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
  moduleName?: string,
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

  const harnessFileName = canAutoWireGoHarness(plan.target)
    ? `${toPascalCase(plan.slug)}_test.go`
    : `${toPascalCase(plan.slug)}_test.go.disabled`;
  const runnableHarness = canAutoWireGoHarness(plan.target);
  const harnessPath = path.join(harnessDir, harnessFileName);

  await fs.writeFile(path.join(harnessDir, "go.mod"), buildGoMod(plan, moduleName));
  await fs.writeFile(
    harnessPath,
    canAutoWireGoHarness(plan.target)
      ? buildReadyGoHarness(plan)
      : buildManualHarness(plan),
  );
  await fs.writeFile(path.join(grammarDir, "grammar.json"), buildGrammarJson(plan));
  await fs.writeFile(path.join(corpusDir, "README.md"), plan.corpusIdeas.join("\n"));
  await fs.writeFile(path.join(campaignRoot, "campaign.json"), JSON.stringify(plan, null, 2));
  await fs.writeFile(path.join(campaignRoot, "FUZZ.md"), buildFuzzDoc(plan));
  await fs.writeFile(path.join(campaignRoot, "FOUND_ISSUES.md"), buildIssuesDoc());
  await fs.writeFile(path.join(campaignRoot, "libafl.config.jsonc"), buildLibAflConfig());
  await fs.writeFile(
    path.join(campaignRoot, "fuzz.bash"),
    buildFuzzScript(config, plan, {
      harnessFileName,
      runnable: runnableHarness,
    }),
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
