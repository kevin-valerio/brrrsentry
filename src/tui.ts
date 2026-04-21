import blessed from "blessed";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeCampaign, createFallbackPlan } from "./campaign.js";
import { discoverTargets } from "./discovery.js";
import {
  autoJudgeFindingWithOpenAI,
  buildCampaignPlanWithOpenAI,
  rankTargetsWithOpenAI,
} from "./openai.js";
import { loadPromptSources } from "./prompts.js";
import { FUZZING_GUIDELINES } from "./guidelines.js";
import { spawnStreaming, type SpawnStreamingResult } from "./process.js";
import type {
  AppConfig,
  CampaignPlan,
  CandidateTarget,
  DiscoveryResult,
  FuzzMode,
  GeneratedCampaign,
  ScopeMode,
} from "./types.js";

type StepName = "mode" | "scope" | "target" | "review" | "result" | "run";

type FindingKind = "crash" | "hang" | "race" | "leak";

interface FuzzFinding {
  kind: FindingKind;
  path: string;
}

interface StepChoice {
  key: string;
  label: string;
  description: string;
}

interface AppState {
  step: StepName;
  fuzzMode?: FuzzMode;
  scopeMode?: ScopeMode;
  discovery?: DiscoveryResult;
  selectedTarget?: CandidateTarget;
  targetDetailsExpanded?: boolean;
  plan?: CampaignPlan;
  generated?: GeneratedCampaign;
  runCores?: string;
  runCommand?: string;
  runLibAflOutputDir?: string;
  runFindings?: FuzzFinding[];
  runAutoJudge?: Awaited<ReturnType<typeof autoJudgeFindingWithOpenAI>>;
  fuzzRunning?: boolean;
}

const modeChoices: StepChoice[] = [
  {
    key: "byte",
    label: "Byte fuzzing",
    description: "Best simple default. Good when the real input format is still unclear.",
  },
  {
    key: "struct-aware",
    label: "Struct-aware fuzzing",
    description: "Useful when gosentry can feed composite Go inputs directly.",
  },
  {
    key: "grammar",
    label: "Grammar fuzzing",
    description: "Best when the target consumes a real language or structured wire format.",
  },
];

const scopeChoices: StepChoice[] = [
  {
    key: "narrow",
    label: "Narrow scope",
    description: "Focus on a specific parser or entrypoint.",
  },
  {
    key: "end-to-end",
    label: "End-to-end",
    description: "Push the harness toward higher-level application logic.",
  },
  {
    key: "differential",
    label: "Differential",
    description: "Prefer oracles, second implementations, and disagreement-based checks.",
  },
];

function formatPathShort(inputPath: string): string {
  const normalized = path.resolve(inputPath);
  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length <= 3) {
    return normalized;
  }
  return ["...", ...parts.slice(-3)].join(path.sep);
}

function renderStepProgress(current: StepName): string {
  const steps: Array<{ key: StepName; label: string }> = [
    { key: "mode", label: "Mode" },
    { key: "scope", label: "Scope" },
    { key: "target", label: "Target" },
    { key: "review", label: "Review" },
    { key: "result", label: "Generate" },
    { key: "run", label: "Run" },
  ];
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.key === current),
  );

  return steps
    .map((step, index) => {
      const text = `${index + 1} ${step.label}`;
      if (index < currentIndex) {
        return `{green-fg}${text}{/green-fg}`;
      }
      if (index === currentIndex) {
        return `{bold}{green-fg}${text}{/green-fg}{/bold}`;
      }
      return `{green-fg}${text}{/green-fg}`;
    })
    .join(" {gray-fg}>{/gray-fg} ");
}

function buildHeader(config: AppConfig, state: AppState): string {
  return [
    `{bold}brrrsentry{/bold}`,
    `{cyan-fg}t{/cyan-fg}:${formatPathShort(config.targetDir)}`,
    `{cyan-fg}m{/cyan-fg}:${config.model}/${config.reasoningEffort}`,
    renderStepProgress(state.step),
  ].join("  {gray-fg}|{/gray-fg}  ");
}

function renderChoices(list: blessed.Widgets.ListElement, choices: StepChoice[]): void {
  list.setItems(choices.map((choice) => choice.label));
  list.select(0);
}

function canAutoWireGoHarness(candidate: CandidateTarget): boolean {
  return (
    candidate.language === "go" &&
    !candidate.hasReceiver &&
    Boolean(candidate.importPath) &&
    Boolean(candidate.packageName) &&
    Boolean(candidate.isExported) &&
    candidate.argCount === 1 &&
    Boolean(candidate.acceptsBytes || candidate.acceptsString)
  );
}

function renderTargets(
  list: blessed.Widgets.ListElement,
  candidates: CandidateTarget[],
): void {
  const selectedIndex =
    typeof (list as any).selected === "number" ? (list as any).selected : 0;
  list.setItems(
    candidates.map(
      (candidate) => {
        const harnessTag = canAutoWireGoHarness(candidate) ? "AUTO" : "MANUAL";
        return `[${harnessTag}] ${candidate.symbol} [${candidate.language}] score=${candidate.score} ${candidate.relativePath}`;
      },
    ),
  );
  if (candidates.length > 0) {
    list.select(Math.min(selectedIndex, candidates.length - 1));
  }
}

function choiceFromIndex<T>(values: T[], index: number): T | undefined {
  return values[index];
}

function normalizeCoresInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "0";
  }

  if (trimmed.includes(",")) {
    const parts = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join(",") : "0";
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return trimmed;
  }

  if (parsed <= 0) {
    return "0";
  }

  return Array.from({ length: parsed }, (_value, index) => String(index)).join(",");
}

async function collectFindings(
  libAflOutputDir: string,
  options?: { sinceMs?: number },
): Promise<FuzzFinding[]> {
  const mappings: Array<{ kind: FindingKind; dir: string }> = [
    { kind: "crash", dir: "crashes" },
    { kind: "hang", dir: "hangs" },
    { kind: "race", dir: "races" },
    { kind: "leak", dir: "leaks" },
  ];

  const findings: FuzzFinding[] = [];

  for (const mapping of mappings) {
    const fullDir = path.join(libAflOutputDir, mapping.dir);
    try {
      const entries = await fs.readdir(fullDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (entry.name.startsWith(".")) {
          continue;
        }

        const findingPath = path.join(fullDir, entry.name);
        if (options?.sinceMs) {
          try {
            const stat = await fs.stat(findingPath);
            if (stat.mtimeMs < options.sinceMs) {
              continue;
            }
          } catch {
            continue;
          }
        }

        findings.push({ kind: mapping.kind, path: findingPath });
      }
    } catch {
      // missing dir is expected when no findings of that kind exist
    }
  }

  return findings;
}

export async function runTui(config: AppConfig): Promise<void> {
  const prompts = await loadPromptSources(config.repoRoot);
  const state: AppState = { step: "mode" };
  const inputUnlockDelayMs = 160;
  const statusFlowMaxChars = 280;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "brrrsentry",
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: "line",
    style: { border: { fg: "cyan" } },
  });

  const main = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "60%",
    bottom: 3,
    border: "line",
    label: " Flow ",
    style: { border: { fg: "green" } },
  });

  const rightPane = blessed.box({
    parent: screen,
    top: 3,
    left: "60%",
    width: "40%",
    bottom: 3,
  });

  const harnessBox = blessed.box({
    parent: rightPane,
    top: 0,
    left: 0,
    width: "100%",
    height: "60%",
    border: "line",
    label: " Harness ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: { border: { fg: "yellow" } },
  });

  const expandButton = blessed.box({
    parent: harnessBox,
    top: 0,
    right: 1,
    width: 5,
    height: 3,
    content: "[+]",
    align: "center",
    valign: "middle",
    mouse: true,
    style: {
      fg: "black",
      bg: "white",
      hover: { bg: "green" },
    },
  });

  const statusBox = blessed.box({
    parent: rightPane,
    bottom: 0,
    left: 0,
    width: "100%",
    height: "40%",
    border: "line",
    label: " Status ",
    style: { border: { fg: "yellow" } },
  });

  const statusLine = blessed.box({
    parent: statusBox,
    top: 0,
    left: 0,
    width: "100%",
    height: 6,
    tags: true,
    wrap: true,
    style: { fg: "white" },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    style: { border: { fg: "magenta" } },
  });

  const list = blessed.list({
    parent: main,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { bg: "blue" },
      item: { hover: { bg: "blue" } },
    },
  });

  const flowLog = blessed.log({
    parent: main,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    hidden: true,
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
  });

  const logBox = blessed.log({
    parent: statusBox,
    top: 6,
    left: 0,
    width: "100%",
    height: "100%-6",
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
  });

  const runPrompt = blessed.prompt({
    parent: screen,
    top: "center",
    left: "center",
    width: "70%",
    height: 9,
    border: "line",
    label: " Run now? ",
    tags: true,
    hidden: true,
    keys: true,
    vi: true,
    style: { border: { fg: "magenta" } },
  });

  const spinnerFrames = ["|", "/", "-", "\\"];
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerStartMs = 0;
  let spinnerPrefix = "";
  let statusPrimary = "";
  let statusDetail = "";
  let statusFlow = "";
  let spinnerIndex = 0;
  let activeFuzz: ReturnType<typeof spawnStreaming> | null = null;
  let quitAfterFuzzStops = false;
  let inputLocked = false;
  let inputUnlockTimer: NodeJS.Timeout | undefined;

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  }

  function formatStatusFlow(text: string): string {
    const compact = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" ");
    if (compact.length === 0) {
      return "";
    }

    const trimmed =
      compact.length > statusFlowMaxChars
        ? `...${compact.slice(-statusFlowMaxChars)}`
        : compact;
    return `Model flow: ${trimmed}`;
  }

  function renderStatus(): void {
    const lines = [`{bold}${statusPrimary}{/bold}`];
    if (statusDetail.length > 0) {
      lines.push(`{gray-fg}${blessed.escape(statusDetail)}{/gray-fg}`);
    }
    if (statusFlow.length > 0) {
      lines.push(`{gray-fg}${blessed.escape(statusFlow)}{/gray-fg}`);
    }
    statusLine.setContent(lines.join("\n"));
  }

  function setStatus(text: string, detail?: string): void {
    stopSpinner();
    statusPrimary = text;
    statusDetail = detail ?? "";
    statusFlow = "";
    renderStatus();
    screen.render();
  }

  function setStatusFlow(text: string): void {
    statusFlow = formatStatusFlow(text);
    renderStatus();
    screen.render();
  }

  function startSpinner(prefix: string, detail?: string): void {
    stopSpinner();
    spinnerPrefix = prefix;
    statusPrimary = prefix;
    statusDetail = detail ?? "";
    statusFlow = "";
    spinnerStartMs = Date.now();
    spinnerIndex = 0;

    const tick = () => {
      const elapsedSeconds = Math.floor((Date.now() - spinnerStartMs) / 1000);
      const frame = spinnerFrames[spinnerIndex++ % spinnerFrames.length];
      statusPrimary = `${spinnerPrefix} {cyan-fg}${frame}{/cyan-fg} {gray-fg}${elapsedSeconds}s{/gray-fg}`;
      renderStatus();
      screen.render();
    };

    spinnerTimer = setInterval(tick, 250);
    tick();
  }

  function setInputLocked(locked: boolean): void {
    inputLocked = locked;
    (list as any).interactive = !locked;
  }

  function clearInputUnlockTimer(): void {
    if (inputUnlockTimer) {
      clearTimeout(inputUnlockTimer);
      inputUnlockTimer = undefined;
    }
  }

  function lockInput(): void {
    clearInputUnlockTimer();
    setInputLocked(true);
  }

  function unlockInput(delayMs = 0): void {
    clearInputUnlockTimer();
    if (delayMs <= 0) {
      setInputLocked(false);
      redraw();
      return;
    }

    inputUnlockTimer = setTimeout(() => {
      inputUnlockTimer = undefined;
      setInputLocked(false);
      redraw();
    }, delayMs);
  }

  function pushLog(message: string): void {
    logBox.add(message);
    screen.render();
  }

  function pushFlow(message: string): void {
    flowLog.add(message);
    screen.render();
  }

  function setFooter(text: string): void {
    footer.setContent(text);
  }

  function renderHarness(text: string): void {
    harnessBox.setContent(text);
    harnessBox.setScroll(0);
  }

  function currentListIndex(): number {
    return typeof (list as any).selected === "number" ? (list as any).selected : 0;
  }

  function describeHarness(
    candidate: CandidateTarget,
  ): { short: string; long: string } {
    const runnable = canAutoWireGoHarness(candidate);
    const harnessBadge = runnable
      ? "{bold}{green-fg}AUTO{/green-fg}{/bold}"
      : "{bold}{yellow-fg}MANUAL{/yellow-fg}{/bold}";
    const languageBadge =
      candidate.language === "go"
        ? "{cyan-fg}go{/cyan-fg}"
        : candidate.language === "rust"
          ? "{magenta-fg}rust{/magenta-fg}"
          : "{yellow-fg}c{/yellow-fg}";
    const inputType = candidate.acceptsBytes
      ? "[]byte"
      : candidate.acceptsString
        ? "string"
        : "unknown";

    const shortLines = [
      `{bold}Target{/bold}: {bold}${candidate.symbol}{/bold} [${languageBadge}]`,
      `{bold}Harness{/bold}: ${harnessBadge} {gray-fg}${runnable ? "in-process Go harness" : "manual template"}{/gray-fg}`,
      runnable
        ? `{bold}Would do{/bold}: fuzz ${candidate.symbol}(${inputType}) in-process; optional differential vs BRRRSENTRY_ORACLE_BIN.`
        : "{bold}Would do{/bold}: generate campaign + notes; you hand-wire the real harness for this target.",
      "{gray-fg}Tip: press + (or click [+]) for details.{/gray-fg}",
    ];

    const longLines = [
      ...shortLines,
      "",
      "{bold}Details{/bold}",
      "",
      `{bold}Path{/bold}: ${candidate.relativePath}`,
      `{bold}Signature{/bold}: ${candidate.signature}`,
      `{bold}Kind{/bold}: ${candidate.kind} {gray-fg}(score=${candidate.score}){/gray-fg}`,
      candidate.importPath
        ? `{bold}Import{/bold}: ${candidate.importPath}`
        : "{bold}Import{/bold}: {gray-fg}(not inferred){/gray-fg}",
      candidate.packageName
        ? `{bold}Package{/bold}: ${candidate.packageName}`
        : "{bold}Package{/bold}: {gray-fg}(unknown){/gray-fg}",
      `{bold}Receiver{/bold}: ${candidate.hasReceiver ? "{red-fg}yes{/red-fg}" : "{green-fg}no{/green-fg}"}  {bold}Exported{/bold}: ${candidate.isExported ? "{green-fg}yes{/green-fg}" : "{red-fg}no{/red-fg}"}  {bold}Args{/bold}: ${candidate.argCount ?? 0}`,
      `{bold}Input{/bold}: bytes=${candidate.acceptsBytes ? "{green-fg}yes{/green-fg}" : "{gray-fg}no{/gray-fg}"} string=${candidate.acceptsString ? "{green-fg}yes{/green-fg}" : "{gray-fg}no{/gray-fg}"}`,
      "",
      candidate.reasons.length > 0
        ? `{bold}Reasons{/bold}: ${candidate.reasons.join(", ")}`
        : "{bold}Reasons{/bold}: {gray-fg}(none){/gray-fg}",
    ];

    return {
      short: shortLines.join("\n"),
      long: longLines.join("\n"),
    };
  }

  function refreshHarnessPane(): void {
    if (state.step === "mode") {
      renderHarness(
        modeChoices
          .map((choice, index) => `${index + 1}. ${choice.label}\n${choice.description}`)
          .join("\n\n"),
      );
      expandButton.hide();
      return;
    }

    if (state.step === "scope") {
      renderHarness(
        scopeChoices
          .map((choice, index) => `${index + 1}. ${choice.label}\n${choice.description}`)
          .join("\n\n"),
      );
      expandButton.hide();
      return;
    }

    if (state.step === "target" && state.discovery) {
      const candidate = choiceFromIndex(state.discovery.recommended, currentListIndex());
      if (!candidate) {
        renderHarness("No target selected.");
        expandButton.hide();
        return;
      }

      const expanded = Boolean(state.targetDetailsExpanded);
      const description = describeHarness(candidate);
      renderHarness(expanded ? description.long : description.short);
      expandButton.setContent(expanded ? "[-]" : "[+]");
      expandButton.show();
      return;
    }

    if (state.step === "review" && state.plan) {
      renderHarness(
        [
          "Key guidelines:",
          ...FUZZING_GUIDELINES.slice(0, 4).flatMap((section) => [
            `${section.title}:`,
            ...section.bullets.slice(0, 2).map((bullet) => `- ${bullet}`),
            "",
          ]),
          `Title: ${state.plan.title}`,
          `Target: ${state.plan.target.symbol}`,
          `Path: ${state.plan.target.relativePath}`,
          `Fuzz mode: ${state.plan.fuzzMode}`,
          `Scope: ${state.plan.scopeMode}`,
          "",
          `Oracle: ${state.plan.oracleStrategy}`,
          "",
          `Harness: ${state.plan.harnessStrategy}`,
          "",
          "Corpus ideas:",
          ...state.plan.corpusIdeas.map((idea) => `- ${idea}`),
        ].join("\n"),
      );
      expandButton.hide();
      return;
    }

    if (state.step === "result" && state.generated) {
      const runLines: string[] = [];

      if (state.runCommand) {
        runLines.push("{bold}Last run{/bold}");
        runLines.push("");
        runLines.push(`Command: ${state.runCommand}`);
        if (state.runLibAflOutputDir) {
          runLines.push(`LibAFL output: ${state.runLibAflOutputDir}`);
        }
        if (state.runFindings && state.runFindings.length > 0) {
          runLines.push("Findings:");
          for (const finding of state.runFindings.slice(0, 8)) {
            runLines.push(`- ${finding.kind}: ${finding.path}`);
          }
        }
        if (state.runAutoJudge) {
          runLines.push("");
          runLines.push("{bold}Auto-judge{/bold}");
          runLines.push("");
          runLines.push(
            `Verdict: ${state.runAutoJudge.verdict} (${state.runAutoJudge.root_cause})`,
          );
          runLines.push(state.runAutoJudge.reason);
        }
        runLines.push("");
      }

      renderHarness(
        [
          `Campaign root: ${state.generated.rootDir}`,
          `FUZZ.md: ${state.generated.fuzzDocPath}`,
          `FOUND_ISSUES.md: ${state.generated.issuesPath}`,
          `fuzz.bash: ${state.generated.fuzzScriptPath}`,
          `Harness: ${state.generated.harnessPath}`,
          "",
          "Next: choose Run now to start fuzzing from the TUI.",
          ...runLines,
        ].join("\n"),
      );
      expandButton.hide();
      return;
    }

    if (state.step === "run" && state.generated) {
      const lines: string[] = [
        `Campaign root: ${state.generated.rootDir}`,
        "",
        state.runCommand ? `Command: ${state.runCommand}` : "Command: (not set yet)",
        state.fuzzRunning
          ? "Status: running"
          : "Status: stopped",
      ];

      if (state.runLibAflOutputDir) {
        lines.push(`LibAFL output: ${state.runLibAflOutputDir}`);
      }

      if (state.runFindings && state.runFindings.length > 0) {
        lines.push("");
        lines.push("Findings:");
        for (const finding of state.runFindings.slice(0, 10)) {
          lines.push(`- ${finding.kind}: ${finding.path}`);
        }
      }

      if (state.runAutoJudge) {
        lines.push("");
        lines.push("Auto-judge:");
        lines.push(`- verdict: ${state.runAutoJudge.verdict}`);
        lines.push(`- root cause: ${state.runAutoJudge.root_cause}`);
        lines.push(`- reason: ${state.runAutoJudge.reason}`);
        if (state.runAutoJudge.fixed_harness_source) {
          lines.push("- harness fix: applied");
        }
      }

      renderHarness(lines.join("\n"));
      expandButton.hide();
      return;
    }

    renderHarness("");
    expandButton.hide();
  }

  function redraw(): void {
    header.setContent(buildHeader(config, state));
    list.show();
    flowLog.hide();

    if (state.step === "mode") {
      renderChoices(list, modeChoices);
      setFooter("Arrows + Enter: choose fuzz mode | q: quit");
    } else if (state.step === "scope") {
      renderChoices(list, scopeChoices);
      setFooter("Arrows + Enter: choose scope mode | q: quit");
    } else if (state.step === "target" && state.discovery) {
      renderTargets(list, state.discovery.recommended);
      setFooter("Arrows: choose target | Enter: select | +: harness info | q: quit");
    } else if (state.step === "review" && state.plan) {
      const actions: StepChoice[] = [
        {
          key: "generate",
          label: "Generate campaign files",
          description: "Write the campaign under .brrrsentry/",
        },
      ];
      renderChoices(list, actions);
      setFooter("Enter: generate files | q: quit");
    } else if (state.step === "result" && state.generated) {
      const actions: StepChoice[] = [
        {
          key: "run",
          label: "Run now",
          description: "Run the gosentry campaign (asks cores first).",
        },
        {
          key: "done",
          label: "Done",
          description: "Exit the TUI",
        },
      ];
      renderChoices(list, actions);
      setFooter("Enter: action | q: quit");
    } else if (state.step === "run") {
      list.hide();
      flowLog.show();
      flowLog.focus();
      setFooter("s: stop fuzzing | b: back | q: quit");
    }

    refreshHarnessPane();
    screen.render();
  }

  async function runDiscoveryFlow(): Promise<void> {
    startSpinner(
      "Scanning target directory",
      "Static scan: Go/Rust/C/C++ entrypoints",
    );
    pushLog("Scanning target directory...");
    state.discovery = await discoverTargets(config.targetDir);
    pushLog(`Static candidates found: ${state.discovery.candidates.length}`);

    for (const note of state.discovery.notes) {
      pushLog(`Discovery: ${note}`);
    }

    if (state.discovery.candidates.length === 0) {
      setStatus("No targets found", "Static scan returned 0 candidates");
      return;
    }

    const sentCandidates = Math.min(state.discovery.candidates.length, 12);
    startSpinner(
      "Ranking targets",
      `Model: ${config.model}/${config.reasoningEffort} | sent: ${sentCandidates}`,
    );
    pushLog("Ranking targets...");

    try {
      const ranked = await rankTargetsWithOpenAI(
        config,
        state.discovery,
        prompts,
        {
          fuzzMode: state.fuzzMode,
          scopeMode: state.scopeMode,
        },
        {
          onReasoningSummary: setStatusFlow,
        },
      );
      const chosen = ranked.recommendedIds
        .map((id) => state.discovery?.candidates.find((candidate) => candidate.id === id))
        .filter((candidate): candidate is CandidateTarget => candidate !== undefined);
      if (chosen.length === 0) {
        throw new Error("model returned no valid targets");
      }

      const chosenGo = chosen.filter((candidate) => candidate.language === "go");
      state.discovery.recommended =
        chosenGo.length > 0 ? chosenGo.slice(0, 3) : chosen.slice(0, 3);

      for (const note of ranked.notes) {
        pushLog(`Model: ${note}`);
      }
    } catch (error) {
      setStatus("Target ranking failed", (error as Error).message);
      throw error;
    }

    state.step = "target";
    state.targetDetailsExpanded = false;
    setStatus("Review targets", "Enter: select | +: harness info");
    redraw();
  }

  async function buildPlanFlow(target: CandidateTarget): Promise<void> {
    if (!state.fuzzMode || !state.scopeMode) {
      throw new Error("wizard state is incomplete");
    }

    const planningMode = "Drafting campaign plan";
    startSpinner(
      planningMode,
      `Model: ${config.model}/${config.reasoningEffort} | target: ${target.symbol}`,
    );
    pushLog(`${planningMode} for ${target.symbol}...`);

    let plan = createFallbackPlan(target, state.fuzzMode, state.scopeMode);

    try {
      const enriched = await buildCampaignPlanWithOpenAI(
        config,
        prompts,
        target,
        state.fuzzMode,
        state.scopeMode,
        {
          onReasoningSummary: setStatusFlow,
        },
      );
      plan = {
        ...plan,
        ...enriched,
      };
      pushLog(`Plan: ${plan.title}`);
    } catch (error) {
      setStatus("Plan drafting failed", (error as Error).message);
      throw error;
    }

    state.plan = plan;
    state.step = "review";
    setStatus("Review campaign plan", plan.title);
    redraw();
  }

  async function generateFlow(): Promise<void> {
    if (!state.plan) {
      throw new Error("campaign plan is missing");
    }

    startSpinner("Writing campaign workspace", `.brrrsentry/campaigns/${state.plan.slug}`);
    pushLog("Writing campaign workspace...");
    state.generated = await writeCampaign(
      config,
      state.plan,
      state.discovery?.moduleName,
    );
    state.step = "result";
    setStatus("Campaign generated", `.brrrsentry/campaigns/${state.plan.slug}`);
    redraw();
  }

  function stopFuzzing(): void {
    if (!activeFuzz) {
      return;
    }
    try {
      activeFuzz.child.kill("SIGINT");
    } catch {
      // ignore
    }
  }

  function formatExitSummary(result: SpawnStreamingResult): string {
    if (result.signal) {
      return `signal=${result.signal}`;
    }
    if (typeof result.exitCode === "number") {
      return `exit=${result.exitCode}`;
    }
    return "exit=unknown";
  }

  async function promptRunCores(): Promise<string | null> {
    const suggested = Math.min(os.cpus().length, 4);
    const defaultValue = state.runCores ?? String(Math.max(1, suggested));

    return await new Promise((resolve) => {
      runPrompt.input(
        "Cores (number or list like 0,1,2,3):",
        defaultValue,
        (err, value) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(value);
        },
      );
    });
  }

  async function runNowFlow(): Promise<void> {
    if (!state.generated || !state.plan) {
      throw new Error("campaign is not generated yet");
    }

    if (state.generated.harnessPath.endsWith(".disabled")) {
      setStatus("Harness not runnable yet", "This campaign needs manual harness wiring first.");
      return;
    }

    const rawCores = await promptRunCores();
    if (!rawCores) {
      setStatus("Run cancelled");
      return;
    }

    const cores = normalizeCoresInput(rawCores);
    state.runCores = cores;
    state.runCommand = `CORES=${cores} ./fuzz.bash`;
    state.runLibAflOutputDir = undefined;
    state.runFindings = undefined;
    state.runAutoJudge = undefined;
    state.step = "run";

    flowLog.setContent("");
    flowLog.setScroll(0);
    pushFlow(`$ ${state.runCommand}`);

    redraw();

    const libAflPattern = /^libafl output dir:\s*(.+)$/i;
    let autoRerunsRemaining = 1;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const runStartedMs = Date.now();
      const outputTail: string[] = [];
      const tailLimit = 260;

      state.fuzzRunning = true;
      setStatus(attempt === 1 ? "Fuzzing" : "Re-running fuzzing", `cores=${cores}`);
      redraw();

      activeFuzz = spawnStreaming("./fuzz.bash", [], {
        cwd: state.generated.rootDir,
        env: {
          ...process.env,
          CORES: cores,
          GOSENTRY_ROOT: config.gosentryPath,
        },
        onLine: (line) => {
          outputTail.push(line);
          if (outputTail.length > tailLimit) {
            outputTail.shift();
          }
          pushFlow(line);

          const match = line.match(libAflPattern);
          if (match && match[1]) {
            state.runLibAflOutputDir = match[1].trim();
            refreshHarnessPane();
            screen.render();
          }
        },
      });

      const result = await activeFuzz.completion;
      activeFuzz = null;
      state.fuzzRunning = false;

      if (quitAfterFuzzStops) {
        stopSpinner();
        clearInputUnlockTimer();
        screen.destroy();
        return;
      }

      setStatus("Fuzzing stopped", formatExitSummary(result));

      if (state.runLibAflOutputDir) {
        state.runFindings = await collectFindings(state.runLibAflOutputDir, {
          sinceMs: runStartedMs,
        });
      } else {
        state.runFindings = [];
      }

      if (state.runFindings.length === 0) {
        if (attempt === 1) {
          setStatus("Fuzzing stopped", "No findings detected yet.");
        } else {
          pushFlow("");
          pushFlow("Auto-rerun: no new findings detected.");
        }
        stopSpinner();
        redraw();
        return;
      }

      startSpinner("Auto-judging findings", `Model: ${config.model}/${config.reasoningEffort}`);
      const harnessSource = await fs.readFile(state.generated.harnessPath, "utf8");
      const judgeResult = await autoJudgeFindingWithOpenAI(
        config,
        prompts,
        {
          plan: state.plan,
          campaignRoot: state.generated.rootDir,
          harnessPath: state.generated.harnessPath,
          harnessSource,
          libAflOutputDir: state.runLibAflOutputDir,
          findings: state.runFindings,
          runOutputTail: outputTail.join("\n"),
        },
        {
          onReasoningSummary: setStatusFlow,
        },
      );
      state.runAutoJudge = judgeResult;

      let appliedHarnessFix = false;
      if (
        judgeResult.verdict === "false_positive" &&
        judgeResult.root_cause === "harness" &&
        judgeResult.fixed_harness_source &&
        judgeResult.fixed_harness_source.trim().length > 0
      ) {
        await fs.writeFile(state.generated.harnessPath, judgeResult.fixed_harness_source);
        appliedHarnessFix = true;
        pushFlow("");
        pushFlow("Auto-judge: applied harness fix.");
      }

      stopSpinner();

      if (appliedHarnessFix && autoRerunsRemaining > 0) {
        autoRerunsRemaining -= 1;
        pushFlow("");
        pushFlow(`$ ${state.runCommand}  # auto-rerun after harness fix`);
        continue;
      }

      redraw();
      return;
    }
  }

  list.on("select", async (_item, index) => {
    if (inputLocked) {
      return;
    }

    lockInput();
    let shouldUnlock = true;

    try {
      if (state.step === "mode") {
        const selected = choiceFromIndex(modeChoices, index);
        if (!selected) {
          return;
        }
        state.fuzzMode = selected.key as FuzzMode;
        state.step = "scope";
        redraw();
        return;
      }

      if (state.step === "scope") {
        const selected = choiceFromIndex(scopeChoices, index);
        if (!selected) {
          return;
        }
        state.scopeMode = selected.key as ScopeMode;
        await runDiscoveryFlow();
        return;
      }

      if (state.step === "target" && state.discovery) {
        const selected = choiceFromIndex(state.discovery.recommended, index);
        if (!selected) {
          return;
        }
        state.selectedTarget = selected;
        await buildPlanFlow(selected);
        return;
      }

      if (state.step === "review") {
        await generateFlow();
        return;
      }

      if (state.step === "result" && state.generated) {
        const actions: StepChoice[] = [
          { key: "run", label: "Run now", description: "" },
          { key: "done", label: "Done", description: "" },
        ];
        const selected = choiceFromIndex(actions, index);
        if (!selected) {
          return;
        }
        if (selected.key === "run") {
          await runNowFlow();
          return;
        }
        stopSpinner();
        clearInputUnlockTimer();
        shouldUnlock = false;
        screen.destroy();
      }
    } catch (error) {
      pushLog(`Error: ${(error as Error).message}`);
    } finally {
      if (shouldUnlock) {
        unlockInput(inputUnlockDelayMs);
      }
    }
  });

  list.on("keypress", () => {
    if (inputLocked) {
      return;
    }
    if (state.step === "target") {
      refreshHarnessPane();
      screen.render();
    }
  });

  function toggleTargetDetails(): void {
    if (inputLocked || state.step !== "target") {
      return;
    }
    state.targetDetailsExpanded = !state.targetDetailsExpanded;
    refreshHarnessPane();
    screen.render();
  }

  expandButton.on("click", toggleTargetDetails);
  screen.key(["+"], toggleTargetDetails);

  screen.key(["s"], () => {
    if (state.step !== "run") {
      return;
    }
    if (!activeFuzz) {
      return;
    }
    setStatus("Stopping fuzzing", "Sending SIGINT...");
    stopFuzzing();
  });

  screen.key(["b"], () => {
    if (state.step !== "run") {
      return;
    }
    if (activeFuzz) {
      return;
    }
    state.step = "result";
    redraw();
    list.focus();
  });

  screen.key(["q", "C-c"], () => {
    if (activeFuzz) {
      quitAfterFuzzStops = true;
      setStatus("Stopping fuzzing", "Sending SIGINT...");
      stopFuzzing();
      return;
    }

    stopSpinner();
    clearInputUnlockTimer();
    screen.destroy();
  });

  setStatus("Ready");
  redraw();
  list.focus();
}
