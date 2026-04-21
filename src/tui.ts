import blessed from "blessed";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canAutoWireGoHarness, createFallbackPlan, writeCampaign } from "./campaign.js";
import { buildRepositoryDiscoveryContext } from "./discovery.js";
import {
  autoJudgeFindingWithOpenAI,
  buildCampaignPlanWithOpenAI,
  discoverTargetsWithOpenAI,
  draftGoHarnessWithOpenAI,
  repairGoHarnessWithOpenAI,
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
  plan?: CampaignPlan;
  draftedHarnessSource?: string;
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

function renderTargets(
  list: blessed.Widgets.ListElement,
  candidates: CandidateTarget[],
): void {
  const selectedIndex =
    typeof (list as any).selected === "number" ? (list as any).selected : 0;
  list.setItems(
    candidates.map(
      (candidate) => {
        return `[AUTO] ${candidate.symbol} [${candidate.language}] score=${candidate.score} ${candidate.relativePath}`;
      },
    ),
  );
  if (candidates.length > 0) {
    list.select(Math.min(selectedIndex, candidates.length - 1));
  }
}

function formatLanguageBadge(language: string): string {
  const normalized = language.trim().toLowerCase() || "unknown";

  if (normalized === "go") {
    return `{cyan-fg}${normalized}{/cyan-fg}`;
  }
  if (normalized === "rust") {
    return `{magenta-fg}${normalized}{/magenta-fg}`;
  }
  if (normalized === "c" || normalized === "cpp" || normalized === "c++") {
    return `{yellow-fg}${normalized}{/yellow-fg}`;
  }

  return `{white-fg}${normalized}{/white-fg}`;
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
    width: "50%",
    bottom: 3,
    border: "line",
    label: " Flow ",
    style: { border: { fg: "green" } },
  });

  const flowThinkingHeight = "40%";

  const rightPane = blessed.box({
    parent: screen,
    top: 3,
    left: "50%",
    width: "50%",
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

  const statusLineHeight = 5;

  const statusLine = blessed.box({
    parent: statusBox,
    top: 0,
    left: 0,
    width: "100%",
    height: statusLineHeight,
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

  const thinkingPane = blessed.box({
    parent: main,
    bottom: 0,
    left: 0,
    width: "100%",
    height: flowThinkingHeight,
    border: "line",
    label: " Thinking ",
    tags: false,
    wrap: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    style: { fg: "white", border: { fg: "gray" } },
  });

  const list = blessed.list({
    parent: main,
    top: 0,
    left: 0,
    width: "100%",
    bottom: flowThinkingHeight,
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
    bottom: flowThinkingHeight,
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
    top: statusLineHeight,
    left: 0,
    width: "100%",
    height: `100%-${statusLineHeight}`,
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
  let modelProgressTimer: NodeJS.Timeout | undefined;
  let spinnerStartMs = 0;
  let spinnerPrefix = "";
  let statusPrimary = "";
  let statusDetail = "";
  let statusFlow = "";
  let spinnerIndex = 0;
  let modelProgressSteps: string[] = [];
  let modelProgressIndex = 0;
  let thinkingProgressLines: string[] = [];
  let thinkingReasoningSummary = "";
  let activeFuzz: ReturnType<typeof spawnStreaming> | null = null;
  let quitAfterFuzzStops = false;
  let inputLocked = false;
  let inputUnlockTimer: NodeJS.Timeout | undefined;

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    stopModelProgress();
  }

  function stopModelProgress(): void {
    if (modelProgressTimer) {
      clearInterval(modelProgressTimer);
      modelProgressTimer = undefined;
    }
    modelProgressSteps = [];
    modelProgressIndex = 0;
  }

  function formatStatusFlow(text: string): string {
    const normalized = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    if (normalized.length === 0) {
      return "";
    }

    const trimmed =
      normalized.length > statusFlowMaxChars
        ? `...${normalized.slice(-statusFlowMaxChars)}`
        : normalized;
    return trimmed;
  }

  function normalizeThinkingSummary(text: string): string {
    const normalized = text.replace(/\r/g, "").trim();
    if (normalized.length === 0) {
      return "";
    }
    if (normalized.includes("\n")) {
      return normalized;
    }

    return normalized.replace(/([.!?])\s+(?=[A-Z0-9])/g, "$1\n");
  }

  function renderThinking(): void {
    const shouldScrollToBottom = thinkingPane.getScrollPerc() >= 99;
    const lines: string[] = [];

    const currentProgress = thinkingProgressLines.at(-1);
    if (currentProgress) {
      lines.push("Progress:");
      lines.push(`- ${currentProgress}`);
    }

    const summary = normalizeThinkingSummary(thinkingReasoningSummary);
    if (summary.length > 0) {
      const summaryLines = summary
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 10);

      if (summaryLines.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push("Summary:");
        for (const line of summaryLines) {
          if (/^[-*•]\s+/.test(line)) {
            lines.push(line);
          } else {
            lines.push(`- ${line}`);
          }
        }
      }
    }

    if (lines.length === 0) {
      lines.push("(No model thinking yet.)");
    }

    thinkingPane.setContent(lines.join("\n"));
    if (shouldScrollToBottom) {
      thinkingPane.setScroll(thinkingPane.getScrollHeight());
    }
    screen.render();
  }

  function clearThinking(): void {
    thinkingProgressLines = [];
    thinkingReasoningSummary = "";
    renderThinking();
  }

  function appendThinkingProgress(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }

    const last = thinkingProgressLines.at(-1);
    if (last === trimmed) {
      return;
    }

    thinkingProgressLines.push(trimmed);
    const maxLines = 60;
    if (thinkingProgressLines.length > maxLines) {
      thinkingProgressLines = thinkingProgressLines.slice(-maxLines);
    }

    renderThinking();
  }

  function setThinkingReasoningSummary(text: string): void {
    thinkingReasoningSummary = text;
    renderThinking();
  }

  function renderStatus(): void {
    const lines = [`{bold}${statusPrimary}{/bold}`];
    if (statusDetail.length > 0) {
      lines.push(`{gray-fg}Step: ${blessed.escape(statusDetail)}{/gray-fg}`);
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
    appendThinkingProgress(statusFlow);
  }

  function startModelProgress(steps: string[], intervalMs = 1400): void {
    stopModelProgress();
    clearThinking();
    modelProgressSteps = steps.map((step) => step.trim()).filter(Boolean);
    modelProgressIndex = 0;

    if (modelProgressSteps.length === 0) {
      return;
    }

    setStatusFlow(modelProgressSteps[0] ?? "");

    if (modelProgressSteps.length < 2) {
      return;
    }

    modelProgressTimer = setInterval(() => {
      if (modelProgressIndex >= modelProgressSteps.length - 1) {
        stopModelProgress();
        return;
      }

      modelProgressIndex += 1;
      setStatusFlow(modelProgressSteps[modelProgressIndex] ?? "");

      if (modelProgressIndex >= modelProgressSteps.length - 1) {
        stopModelProgress();
      }
    }, intervalMs);
  }

  function setStatusDetailLine(text: string): void {
    statusDetail = text;
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
  ): string {
    const fastPath = canAutoWireGoHarness(candidate);
    const harnessBadge = "{bold}{green-fg}AUTO{/green-fg}{/bold}";
    const languageBadge = formatLanguageBadge(candidate.language);

    const lines = [
      `{bold}Target{/bold}: {bold}${candidate.symbol}{/bold} [${languageBadge}]`,
      `{bold}Harness{/bold}: ${harnessBadge} {gray-fg}${fastPath ? "simple signature" : "complex signature"}{/gray-fg}`,
      "{bold}Would do{/bold}: auto-generate a runnable harness and run gosentry.",
    ];

    lines.push(
      "",
      "{bold}Details{/bold}",
      "",
      "{bold}Harness wiring{/bold}",
      "",
      "brrrsentry always generates a runnable harness.",
      "It will compile-check the harness before continuing.",
      "If the harness cannot be made to compile, brrrsentry will switch to the next target and tell you.",
      "",
      "{bold}Fast path{/bold}: exported package-level Go func with []byte/string input (and optional context.Context).",
      "{bold}Complex path{/bold}: brrrsentry asks the model to generate harness code + fixes it using compiler errors.",
      "",
      `{bold}Path{/bold}: ${candidate.relativePath}`,
      `{bold}Signature{/bold}: ${candidate.signature}`,
      `{bold}Kind{/bold}: ${candidate.kind} {gray-fg}(score=${candidate.score}){/gray-fg}`,
      ...(candidate.language === "go"
        ? [
            `{bold}Method{/bold}: ${candidate.hasReceiver ? "{red-fg}yes{/red-fg}" : "{green-fg}no{/green-fg}"}  {bold}Public{/bold}: ${candidate.isExported ? "{green-fg}yes{/green-fg}" : "{red-fg}no{/red-fg}"}  {bold}Args{/bold}: ${candidate.argCount ?? 0}`,
            `{bold}Input{/bold}: bytes=${candidate.acceptsBytes ? "{green-fg}yes{/green-fg}" : "{gray-fg}no{/gray-fg}"} string=${candidate.acceptsString ? "{green-fg}yes{/green-fg}" : "{gray-fg}no{/gray-fg}"}`,
          ]
        : []),
    );

    lines.push("");

    if (candidate.reasons.length > 0) {
      lines.push("{bold}Reasons{/bold}:");
      for (const reason of candidate.reasons) {
        const safeReasonLines = blessed
          .escape(reason)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (safeReasonLines.length === 0) {
          continue;
        }
        lines.push(`- ${safeReasonLines[0]}`);
        for (const extraLine of safeReasonLines.slice(1)) {
          lines.push(`  ${extraLine}`);
        }
      }
    } else {
      lines.push("{bold}Reasons{/bold}: {gray-fg}(none){/gray-fg}");
    }

    return lines.join("\n");
  }

  function refreshHarnessPane(): void {
    if (state.step === "mode") {
      renderHarness(
        modeChoices
          .map((choice, index) => `${index + 1}. ${choice.label}\n${choice.description}`)
          .join("\n\n"),
      );
      return;
    }

    if (state.step === "scope") {
      renderHarness(
        scopeChoices
          .map((choice, index) => `${index + 1}. ${choice.label}\n${choice.description}`)
          .join("\n\n"),
      );
      return;
    }

    if (state.step === "target" && state.discovery) {
      const candidate = choiceFromIndex(state.discovery.recommended, currentListIndex());
      if (!candidate) {
        renderHarness("No target selected.");
        return;
      }

      const description = describeHarness(candidate);
      renderHarness(description);
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
      return;
    }

    renderHarness("");
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
      setFooter("Arrows: choose target | Enter: select | q: quit");
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
      "Building repository context for model discovery",
      "Local discovery: file inventory + previews",
    );
    pushLog("Building repository context for model discovery...");
    const discoveryContext = await buildRepositoryDiscoveryContext(config.targetDir, {
      onProgress: (message) => {
        setStatusDetailLine(message);
        pushLog(`Local discovery: ${message}`);
      },
    });

    if (discoveryContext.previews.length === 0) {
      state.discovery = {
        moduleName: discoveryContext.moduleName,
        moduleRoot: discoveryContext.moduleRoot,
        candidates: [],
        recommended: [],
        notes: [...discoveryContext.notes],
      };
    } else {
      setStatusDetailLine(
        `Prepared ${discoveryContext.previews.length} file previews from ${discoveryContext.totalFiles} files`,
      );
      pushLog(
        `Prepared ${discoveryContext.previews.length} file previews from ${discoveryContext.totalFiles} files`,
      );

      startSpinner(
        "Discovering likely fuzz targets",
        `Model: ${config.model}/${config.reasoningEffort} | previews: ${discoveryContext.previews.length}`,
      );
      pushLog("Discovering likely fuzz targets with the model...");
      startModelProgress([
        "reviewing repository previews",
        "choosing strong fuzz entrypoints",
        "ordering the best target candidates",
        "validating target JSON",
      ]);

      try {
        state.discovery = await discoverTargetsWithOpenAI(
          config,
          discoveryContext,
          prompts,
          {
            fuzzMode: state.fuzzMode,
            scopeMode: state.scopeMode,
          },
          {
            onReasoningSummary: setThinkingReasoningSummary,
          },
        );
        setStatusFlow("validating target JSON");
      } catch (error) {
        setStatus("Target discovery failed", (error as Error).message);
        throw error;
      } finally {
        stopModelProgress();
      }
    }

    if (state.discovery.candidates.length === 0) {
      for (const note of state.discovery.notes) {
        pushLog(`Discovery: ${note}`);
      }
      setStatus("No targets found", "Agentic discovery returned 0 candidates");
      return;
    }

    setStatusDetailLine(`Found ${state.discovery.candidates.length} discovered targets`);
    pushLog(`Found ${state.discovery.candidates.length} discovered targets`);

    for (const note of state.discovery.notes) {
      pushLog(`Discovery: ${note}`);
    }

    state.step = "target";
    setStatus("Review targets", "Enter: select");
    redraw();
  }

  function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async function readTargetSnippet(candidate: CandidateTarget): Promise<string> {
    try {
      const raw = await fs.readFile(candidate.filePath, "utf8");
      const normalized = raw.replace(/\r/g, "");
      const lines = normalized.split("\n");
      const head = lines.slice(0, 120).join("\n").slice(0, 5200).trimEnd();

      const symbol = candidate.symbol.trim();
      const matcher = new RegExp(
        `func\\s+(?:\\([^)]*\\)\\s*)?${escapeRegExp(symbol)}\\s*\\(`,
        "m",
      );
      const match = matcher.exec(normalized);
      if (!match || typeof match.index !== "number") {
        return `FILE HEAD:\n${head}`;
      }

      const start = Math.max(0, match.index - 1400);
      const end = Math.min(normalized.length, match.index + 3600);
      const around = normalized
        .slice(start, end)
        .split("\n")
        .slice(0, 200)
        .join("\n")
        .slice(0, 7200)
        .trimEnd();

      return [`FILE HEAD:\n${head}`, "", `AROUND ${symbol}:\n${around}`]
        .filter((part) => part.trim().length > 0)
        .join("\n");
    } catch {
      return "";
    }
  }

  async function compileGoHarness(params: {
    moduleName: string;
    moduleRoot: string;
    harnessSource: string;
  }): Promise<{ ok: boolean; output: string }> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "brrrsentry-harness-"));

    try {
      const goMod = [
        "module brrrsentry/harnesscheck",
        "",
        "go 1.23",
        "",
        `require ${params.moduleName} v0.0.0`,
        `replace ${params.moduleName} => ${params.moduleRoot}`,
        "",
      ].join("\n");

      await fs.writeFile(path.join(tempDir, "go.mod"), goMod);
      await fs.writeFile(path.join(tempDir, "harness_test.go"), params.harnessSource);

      const outputLines: string[] = [];
      const run = spawnStreaming("go", ["test", "-c"], {
        cwd: tempDir,
        env: process.env,
        onLine: (line) => outputLines.push(line),
      });
      const result = await run.completion;
      const output = outputLines.slice(-220).join("\n");

      return {
        ok: result.exitCode === 0,
        output,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async function draftRunnableHarness(plan: CampaignPlan): Promise<string> {
    const moduleName = state.discovery?.moduleName;
    const moduleRoot = state.discovery?.moduleRoot;
    const snippet = await readTargetSnippet(plan.target);

    if (!moduleName || !moduleRoot) {
      throw new Error("missing go.mod module info for harness compilation");
    }
    if (!plan.target.importPath) {
      throw new Error("missing Go import path for selected target");
    }

    setStatusFlow("drafting harness JSON");
    let { harnessSource } = await draftGoHarnessWithOpenAI(
      config,
      prompts,
      { plan, targetFileSnippet: snippet },
      {
        onReasoningSummary: setThinkingReasoningSummary,
      },
    );

    if (!harnessSource) {
      throw new Error("model returned an empty harness_source");
    }

    const maxFixAttempts = 3;
    for (let attempt = 0; attempt < maxFixAttempts; attempt += 1) {
      setStatusFlow("compiling harness");
      const compilation = await compileGoHarness({
        moduleName,
        moduleRoot,
        harnessSource,
      });
      if (compilation.ok) {
        return harnessSource;
      }

      if (attempt >= maxFixAttempts - 1) {
        throw new Error(`harness did not compile after ${maxFixAttempts} attempts\n${compilation.output}`);
      }

      setStatusFlow("fixing harness compile error");
      const repaired = await repairGoHarnessWithOpenAI(
        config,
        prompts,
        {
          plan,
          targetFileSnippet: snippet,
          harnessSource,
          buildError: compilation.output,
        },
        {
          onReasoningSummary: setThinkingReasoningSummary,
        },
      );
      if (!repaired.harnessSource) {
        throw new Error("model returned an empty repaired harness_source");
      }
      harnessSource = repaired.harnessSource;
    }

    return harnessSource;
  }

  async function buildPlanFlow(target: CandidateTarget): Promise<boolean> {
    if (!state.fuzzMode || !state.scopeMode) {
      throw new Error("wizard state is incomplete");
    }

    const planningMode = "Drafting campaign plan";
    startSpinner(
      planningMode,
      `Model: ${config.model}/${config.reasoningEffort} | target: ${target.symbol}`,
    );
    pushLog(`${planningMode} for ${target.symbol}...`);
    startModelProgress([
      "analyzing selected target",
      "drafting harness code",
      "compiling harness",
      "drafting campaign plan",
      "validating plan JSON",
    ]);

    let plan = createFallbackPlan(target, state.fuzzMode, state.scopeMode);

    try {
      state.draftedHarnessSource = await draftRunnableHarness(plan);
    } catch (error) {
      state.draftedHarnessSource = undefined;
      stopModelProgress();
      setStatus("Harness generation failed", (error as Error).message);
      pushLog(`Harness generation failed for ${target.symbol}.`);
      return false;
    }

    try {
      const enriched = await buildCampaignPlanWithOpenAI(
        config,
        prompts,
        target,
        state.fuzzMode,
        state.scopeMode,
        {
          onReasoningSummary: setThinkingReasoningSummary,
        },
      );
      setStatusFlow("validating plan JSON");
      plan = {
        ...plan,
        ...enriched,
      };
      pushLog(`Plan: ${plan.title}`);
    } catch (error) {
      pushLog(`Plan: using fallback (model failed: ${(error as Error).message})`);
    } finally {
      stopModelProgress();
    }

    state.plan = plan;
    state.step = "review";
    setStatus("Review campaign plan", plan.title);
    redraw();
    return true;
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
      {
        moduleName: state.discovery?.moduleName,
        moduleRoot: state.discovery?.moduleRoot,
      },
      state.draftedHarnessSource,
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
      startModelProgress([
        "reviewing findings and fuzzer output",
        "deciding whether this looks like a harness issue",
        "drafting a minimal harness fix if needed",
        "validating verdict JSON",
      ]);
      const plan = state.plan!;
      const generated = state.generated!;
      const runFindings = state.runFindings!;
      const harnessSource = await fs.readFile(generated.harnessPath, "utf8");
      const judgeResult = await (async () => {
        try {
          const result = await autoJudgeFindingWithOpenAI(
            config,
            prompts,
            {
              plan,
              campaignRoot: generated.rootDir,
              harnessPath: generated.harnessPath,
              harnessSource,
              libAflOutputDir: state.runLibAflOutputDir,
              findings: runFindings,
              runOutputTail: outputTail.join("\n"),
            },
            {
              onReasoningSummary: setThinkingReasoningSummary,
            },
          );
          setStatusFlow("validating verdict JSON");
          return result;
        } finally {
          stopModelProgress();
        }
      })();
      state.runAutoJudge = judgeResult;

      let appliedHarnessFix = false;
      if (
        judgeResult.verdict === "false_positive" &&
        judgeResult.root_cause === "harness" &&
        judgeResult.fixed_harness_source &&
        judgeResult.fixed_harness_source.trim().length > 0
      ) {
        await fs.writeFile(generated.harnessPath, judgeResult.fixed_harness_source);
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
        const candidatesToTry = [
          selected,
          ...state.discovery.candidates.filter((candidate) => candidate.id !== selected.id),
        ];

        let previousTarget = selected;
        for (const [candidateIndex, candidate] of candidatesToTry.entries()) {
          if (candidateIndex > 0) {
            pushLog(
              `Auto-switching target: ${previousTarget.symbol} failed to generate a runnable harness. Trying ${candidate.symbol}...`,
            );
          }

          state.selectedTarget = candidate;
          const ok = await buildPlanFlow(candidate);
          if (ok) {
            if (candidate.id !== selected.id) {
              pushLog(`Selected target is now: ${candidate.symbol} (${candidate.relativePath})`);
            }
            return;
          }

          previousTarget = candidate;
        }

        state.selectedTarget = undefined;
        state.plan = undefined;
        state.draftedHarnessSource = undefined;
        state.step = "target";
        setStatus("No runnable targets", "All discovered targets failed harness generation.");
        redraw();
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
  renderThinking();
  list.focus();
}
