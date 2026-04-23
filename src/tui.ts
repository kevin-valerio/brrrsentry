import blessed from "blessed";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildReadyGoHarness,
  canAutoWireGoHarness,
  createFallbackPlan,
  writeCampaign,
} from "./campaign.js";
import { buildRepositoryDiscoveryContext } from "./discovery.js";
import {
  autoJudgeFindingWithOpenAI,
  buildCampaignPlanWithOpenAI,
  discoverTargetsWithOpenAI,
  draftGoHarnessWithOpenAI,
  repairGoHarnessWithOpenAI,
} from "./openai.js";
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

type AutoJudgeResult = Awaited<ReturnType<typeof autoJudgeFindingWithOpenAI>>;

type TuiServices = {
  buildReadyGoHarness: typeof buildReadyGoHarness;
  canAutoWireGoHarness: typeof canAutoWireGoHarness;
  createFallbackPlan: typeof createFallbackPlan;
  writeCampaign: typeof writeCampaign;
  buildRepositoryDiscoveryContext: typeof buildRepositoryDiscoveryContext;
  discoverTargetsWithOpenAI: typeof discoverTargetsWithOpenAI;
  draftGoHarnessWithOpenAI: typeof draftGoHarnessWithOpenAI;
  repairGoHarnessWithOpenAI: typeof repairGoHarnessWithOpenAI;
  buildCampaignPlanWithOpenAI: typeof buildCampaignPlanWithOpenAI;
  autoJudgeFindingWithOpenAI: typeof autoJudgeFindingWithOpenAI;
  spawnStreaming: typeof spawnStreaming;
};

export type TuiDriverScript = {
  fuzzMode?: FuzzMode;
  scopeMode?: ScopeMode;
  targetIndex?: number;
  afterResult?: "run" | "done";
  runCores?: string;
  quitAfterRun?: boolean;
  dismissAlerts?: boolean;
};

export type RunTuiOptions = {
  io?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  };
  services?: Partial<TuiServices>;
  driver?: TuiDriverScript;
  hooks?: {
    onAlert?: (alert: { kind: "info" | "warn" | "error"; title: string; body: string }) => void;
  };
};

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
        return `${candidate.symbol} [${candidate.language}] score=${candidate.score} ${candidate.relativePath}`;
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

export async function runTui(config: AppConfig, options?: RunTuiOptions): Promise<void> {
  const services: TuiServices = {
    buildReadyGoHarness: options?.services?.buildReadyGoHarness ?? buildReadyGoHarness,
    canAutoWireGoHarness: options?.services?.canAutoWireGoHarness ?? canAutoWireGoHarness,
    createFallbackPlan: options?.services?.createFallbackPlan ?? createFallbackPlan,
    writeCampaign: options?.services?.writeCampaign ?? writeCampaign,
    buildRepositoryDiscoveryContext:
      options?.services?.buildRepositoryDiscoveryContext ?? buildRepositoryDiscoveryContext,
    discoverTargetsWithOpenAI:
      options?.services?.discoverTargetsWithOpenAI ?? discoverTargetsWithOpenAI,
    draftGoHarnessWithOpenAI:
      options?.services?.draftGoHarnessWithOpenAI ?? draftGoHarnessWithOpenAI,
    repairGoHarnessWithOpenAI:
      options?.services?.repairGoHarnessWithOpenAI ?? repairGoHarnessWithOpenAI,
    buildCampaignPlanWithOpenAI:
      options?.services?.buildCampaignPlanWithOpenAI ?? buildCampaignPlanWithOpenAI,
    autoJudgeFindingWithOpenAI:
      options?.services?.autoJudgeFindingWithOpenAI ?? autoJudgeFindingWithOpenAI,
    spawnStreaming: options?.services?.spawnStreaming ?? spawnStreaming,
  };

  const state: AppState = { step: "mode" };
  const inputUnlockDelayMs = 160;
  const statusFlowMaxChars = 280;

  const screen = blessed.screen({
    input: options?.io?.input as any,
    output: options?.io?.output as any,
    terminal: options?.io ? "ansi" : undefined,
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

  const outputBox = blessed.box({
    parent: rightPane,
    bottom: 0,
    left: 0,
    width: "100%",
    height: "40%",
    border: "line",
    label: " Stdout ",
    tags: false,
    wrap: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    style: { fg: "white", border: { fg: "yellow" } },
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
    bottom: 0,
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
    bottom: 0,
    hidden: true,
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

  const alertMessage = blessed.message({
    parent: screen,
    top: "center",
    left: "center",
    width: "80%",
    height: "shrink",
    border: "line",
    label: " Alert ",
    tags: true,
    hidden: true,
    keys: true,
    vi: true,
    style: { border: { fg: "red" } },
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
  let lastUserActionAtMs = 0;
  let lastUserActionIndex = -1;
  const outputStdoutLines: string[] = [];
  const outputStdoutTailLimit = 900;
  const outputStdoutRenderLimit = 320;

  const driver = options?.driver;
  let driverTimer: NodeJS.Timeout | undefined;

  function driverWrite(data: string): void {
    const input = options?.io?.input as any;
    if (input && typeof input.write === "function") {
      input.write(data);
    }
  }

  function stopDriver(): void {
    if (driverTimer) {
      clearInterval(driverTimer);
      driverTimer = undefined;
    }
  }

  function startDriver(): void {
    if (!driver || driverTimer) {
      return;
    }

    const tick = () => {
      if (!driver) {
        return;
      }

      if (driver.dismissAlerts && !alertMessage.hidden) {
        driverWrite("\n");
        return;
      }

      if (inputLocked) {
        return;
      }

      if (state.step === "mode") {
        const desired = driver.fuzzMode ?? "byte";
        const index = modeChoices.findIndex((choice) => choice.key === desired);
        list.select(Math.max(0, index));
        (list as any).enterSelected();
        return;
      }

      if (state.step === "scope") {
        const desired = driver.scopeMode ?? "narrow";
        const index = scopeChoices.findIndex((choice) => choice.key === desired);
        list.select(Math.max(0, index));
        (list as any).enterSelected();
        return;
      }

      if (state.step === "target") {
        const index = Math.max(0, driver.targetIndex ?? 0);
        list.select(index);
        (list as any).enterSelected();
        return;
      }

      if (state.step === "review") {
        list.select(0);
        (list as any).enterSelected();
        return;
      }

      if (state.step === "result") {
        const after = driver.afterResult ?? "done";
        list.select(after === "run" ? 0 : 1);
        (list as any).enterSelected();
        return;
      }

      if (
        state.step === "run" &&
        driver.quitAfterRun &&
        !state.fuzzRunning &&
        !activeFuzz &&
        state.runFindings &&
        (state.runFindings.length === 0 || Boolean(state.runAutoJudge))
      ) {
        driverWrite("q");
      }
    };

    driverTimer = setInterval(tick, 60);
  }

  function truncateForAlert(text: string, maxChars: number): string {
    const normalized = text.replace(/\r/g, "").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars).trimEnd()}\n... (truncated)`;
  }

  async function showAlert(
    kind: "info" | "warn" | "error",
    title: string,
    body: string,
  ): Promise<void> {
    options?.hooks?.onAlert?.({ kind, title, body });

    const borderColor =
      kind === "error" ? "red" : kind === "warn" ? "yellow" : "cyan";

    alertMessage.style.border = { fg: borderColor };
    alertMessage.setLabel(` ${title} `);

    const safeBody = blessed.escape(body);
    const content = truncateForAlert(safeBody, 1800);

    await new Promise<void>((resolve) => {
      alertMessage.display(content, 0, () => resolve());
    });
  }

  async function recordRealBug(params: {
    plan: CampaignPlan;
    generated: GeneratedCampaign;
    findings: FuzzFinding[];
    judge: AutoJudgeResult;
    runCommand?: string;
    libAflOutputDir?: string;
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    const lines: string[] = [];

    lines.push("");
    lines.push("");
    lines.push(`## ${timestamp} - ${params.plan.target.symbol}`);
    lines.push("");
    lines.push(`- verdict: ${params.judge.verdict}`);
    lines.push(`- root cause: ${params.judge.root_cause}`);
    if (params.runCommand) {
      lines.push(`- command: ${params.runCommand}`);
    }
    if (params.libAflOutputDir) {
      lines.push(`- libafl output: ${params.libAflOutputDir}`);
    }
    lines.push("");
    lines.push("Findings:");
    for (const finding of params.findings) {
      lines.push(`- ${finding.kind}: ${finding.path}`);
    }
    lines.push("");
    lines.push("Triage reason:");
    lines.push(params.judge.reason.trim().length > 0 ? params.judge.reason.trim() : "(empty)");
    lines.push("");

    await fs.appendFile(params.generated.issuesPath, lines.join("\n"));
  }

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

  function renderOutput(): void {
    const shouldScrollToBottom = outputBox.getScrollPerc() >= 99;
    const lines: string[] = [];

    const primary = statusPrimary.trim();
    const detail = statusDetail.trim();
    const statusText = [primary, detail].filter(Boolean).join(" | ");
    lines.push(`Status: ${statusText.length > 0 ? statusText : "(empty)"}`);

    const currentProgress = thinkingProgressLines.at(-1);
    const summary = normalizeThinkingSummary(thinkingReasoningSummary);
    const summaryLines =
      summary.length > 0
        ? summary
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, 8)
        : [];

    if (currentProgress) {
      lines.push(`Progress: ${currentProgress}`);
    }
    if (summaryLines.length > 0) {
      lines.push("");
      lines.push("Summary:");
      for (const line of summaryLines) {
        lines.push(`- ${line}`);
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");

    const stdoutLines = outputStdoutLines.slice(-outputStdoutRenderLimit);
    if (stdoutLines.length === 0) {
      lines.push("(stdout empty)");
    } else {
      lines.push(...stdoutLines);
    }

    outputBox.setContent(lines.join("\n"));
    if (shouldScrollToBottom) {
      outputBox.setScroll(outputBox.getScrollHeight());
    }
    screen.render();
  }

  function clearThinking(): void {
    thinkingProgressLines = [];
    thinkingReasoningSummary = "";
    renderOutput();
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

    renderOutput();
  }

  function setThinkingReasoningSummary(text: string): void {
    thinkingReasoningSummary = text;
    renderOutput();
  }

  function setStatus(text: string, detail?: string): void {
    stopSpinner();
    statusPrimary = text;
    statusDetail = detail ?? "";
    statusFlow = "";
    renderOutput();
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
    renderOutput();
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
      statusPrimary = `${spinnerPrefix} ${frame} ${elapsedSeconds}s`;
      renderOutput();
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
    const parts = message.replace(/\r/g, "").split("\n");
    for (const part of parts) {
      if (part.trim().length === 0) {
        continue;
      }
      outputStdoutLines.push(`app: ${part}`);
    }
    if (outputStdoutLines.length > outputStdoutTailLimit) {
      outputStdoutLines.splice(0, outputStdoutLines.length - outputStdoutTailLimit);
    }
    renderOutput();
  }

  function pushFlow(message: string): void {
    const parts = message.replace(/\r/g, "").split("\n");
    for (const part of parts) {
      outputStdoutLines.push(part);
    }
    if (outputStdoutLines.length > outputStdoutTailLimit) {
      outputStdoutLines.splice(0, outputStdoutLines.length - outputStdoutTailLimit);
    }
    renderOutput();
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
    const languageBadge = formatLanguageBadge(candidate.language);

    const lines = [
      `{bold}Target{/bold}: {bold}${candidate.symbol}{/bold} [${languageBadge}]`,
      "{bold}Would do{/bold}: generate a ready harness, compile-check it, then run gosentry.",
    ];

    lines.push(
      "",
      "{bold}Details{/bold}",
      "",
      "brrrsentry only lists targets it can auto-wire into a runnable Go harness.",
      "Targets are compile-checked before you can select them.",
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
    if (state.step === "run") {
      main.hide();
      rightPane.left = 0;
      rightPane.width = "100%";
    } else {
      main.show();
      rightPane.left = "50%";
      rightPane.width = "50%";
    }

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
      flowLog.hide();
      outputBox.focus();
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
    const discoveryContext = await services.buildRepositoryDiscoveryContext(config.targetDir, {
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
        state.discovery = await services.discoverTargetsWithOpenAI(
          config,
          discoveryContext,
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

    startSpinner("Checking targets", "Compiling ready harnesses");
    const runnableTargets: CandidateTarget[] = [];
    const skippedTargets: string[] = [];

    for (const candidate of state.discovery.candidates) {
      if (!services.canAutoWireGoHarness(candidate)) {
        skippedTargets.push(`${candidate.symbol} (${candidate.relativePath}): needs custom harness`);
        continue;
      }
      if (!candidate.moduleName || !candidate.moduleRoot) {
        skippedTargets.push(`${candidate.symbol} (${candidate.relativePath}): missing go.mod module`);
        continue;
      }

      const plan = services.createFallbackPlan(candidate, state.fuzzMode!, state.scopeMode!);
      const harnessSource = services.buildReadyGoHarness(plan);
      const compilation = await compileGoHarness({
        moduleName: candidate.moduleName,
        moduleRoot: candidate.moduleRoot,
        harnessSource,
      });
      if (compilation.ok) {
        runnableTargets.push(candidate);
        continue;
      }

      skippedTargets.push(`${candidate.symbol} (${candidate.relativePath}): does not compile`);
      pushLog(`Target skipped: ${candidate.symbol} (${candidate.relativePath})`);
      pushLog(compilation.output.trim().length > 0 ? compilation.output : "(no output)");
    }

    state.discovery = {
      ...state.discovery,
      candidates: runnableTargets,
      recommended: runnableTargets.slice(0, 3),
      notes: [
        ...state.discovery.notes,
        ...(skippedTargets.length > 0
          ? [`Skipped ${skippedTargets.length} targets that were not runnable.`]
          : []),
      ],
    };

    if (state.discovery.candidates.length === 0) {
      for (const note of state.discovery.notes) {
        pushLog(`Discovery: ${note}`);
      }
      setStatus("No runnable targets found", "Only ready-harness targets are supported right now.");
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
      const run = services.spawnStreaming("go", ["test", "-c"], {
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
    const moduleName = plan.target.moduleName;
    const moduleRoot = plan.target.moduleRoot;

    if (!moduleName || !moduleRoot) {
      throw new Error("missing go.mod module info for selected target");
    }
    if (!plan.target.importPath) {
      throw new Error("missing Go import path for selected target");
    }

    if (services.canAutoWireGoHarness(plan.target)) {
      setStatusFlow("building ready harness");
      const harnessSource = services.buildReadyGoHarness(plan);

      setStatusFlow("compiling harness");
      const compilation = await compileGoHarness({
        moduleName,
        moduleRoot,
        harnessSource,
      });
      if (!compilation.ok) {
        throw new Error(`ready harness did not compile\n${compilation.output}`);
      }

      return harnessSource;
    }

    const snippet = await readTargetSnippet(plan.target);
    setStatusFlow("drafting harness JSON");
    let { harnessSource } = await services.draftGoHarnessWithOpenAI(
      config,
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
      const repaired = await services.repairGoHarnessWithOpenAI(
        config,
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

    let plan = services.createFallbackPlan(target, state.fuzzMode, state.scopeMode);

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
      const enriched = await services.buildCampaignPlanWithOpenAI(
        config,
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
    state.generated = await services.writeCampaign(
      config,
      state.plan,
      {
        moduleName: state.plan.target.moduleName,
        moduleRoot: state.plan.target.moduleRoot,
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

  function requestStopFuzzing(): void {
    if (state.step !== "run") {
      return;
    }
    if (!activeFuzz) {
      return;
    }

    setStatus("Stopping fuzzing", "Sending SIGINT...");
    stopFuzzing();
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

  async function ensureGosentryBuilt(): Promise<void> {
    const gosentryBin = path.join(config.gosentryPath, "bin", "go");

    try {
      const stat = await fs.stat(gosentryBin);
      if (stat.isFile()) {
        return;
      }
    } catch {
      // build below
    }

    const gosentrySrcDir = path.join(config.gosentryPath, "src");
    const outputTail: string[] = [];
    const tailLimit = 140;

    startSpinner("Building gosentry", `${formatPathShort(config.gosentryPath)}/src`);
    pushFlow("");
    pushFlow(`# gosentry missing; running ./make.bash in ${gosentrySrcDir}`);

    const build = services.spawnStreaming("./make.bash", [], {
      cwd: gosentrySrcDir,
      env: process.env,
      onLine: (line) => {
        outputTail.push(line);
        if (outputTail.length > tailLimit) {
          outputTail.shift();
        }
        pushFlow(line);
      },
    });
    const result = await build.completion;

    if (result.exitCode !== 0) {
      throw new Error(
        [
          `gosentry build failed (${formatExitSummary(result)})`,
          "",
          "Build output (tail):",
          ...outputTail,
        ].join("\n"),
      );
    }

    try {
      const stat = await fs.stat(gosentryBin);
      if (!stat.isFile()) {
        throw new Error();
      }
    } catch {
      throw new Error(`gosentry build finished, but ${gosentryBin} is still missing`);
    }

    pushFlow("");
    pushFlow(`# gosentry ready: ${gosentryBin}`);
  }

  async function promptRunCores(): Promise<string | null> {
    if (driver?.runCores) {
      return driver.runCores;
    }

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

    outputStdoutLines.length = 0;
    pushFlow(`$ ${state.runCommand}`);

    redraw();

    try {
      await ensureGosentryBuilt();
    } catch (error) {
      setStatus("gosentry build failed", (error as Error).message);
      state.fuzzRunning = false;
      redraw();
      return;
    }

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

      activeFuzz = services.spawnStreaming("./fuzz.bash", [], {
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
        stopDriver();
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
        if (result.exitCode !== 0 && !state.runLibAflOutputDir) {
          pushFlow("");
          pushFlow("Run failed before LibAFL output was created.");
          pushFlow("This usually means gosentry could not build or start the harness.");
          pushFlow("Press b to go back, or scroll to read the build error above.");
          stopSpinner();
          redraw();
          return;
        }

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
          const result = await services.autoJudgeFindingWithOpenAI(
            config,
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

      if (judgeResult.verdict === "real_bug") {
        try {
          await recordRealBug({
            plan,
            generated,
            findings: runFindings,
            judge: judgeResult,
            runCommand: state.runCommand,
            libAflOutputDir: state.runLibAflOutputDir,
          });
          pushFlow("");
          pushFlow(`Recorded finding in ${generated.issuesPath}`);
        } catch (error) {
          pushFlow("");
          pushFlow(`Failed to record finding: ${(error as Error).message}`);
        }

        const alertLines: string[] = [
          "Fuzzing found a real bug.",
          "",
          `Target: ${plan.target.symbol}`,
          `Verdict: ${judgeResult.verdict}`,
          `Root cause: ${judgeResult.root_cause}`,
          "",
          "Reason:",
          judgeResult.reason.trim().length > 0 ? judgeResult.reason.trim() : "(empty)",
          "",
          "Findings:",
          ...runFindings.slice(0, 10).map((finding) => `- ${finding.kind}: ${finding.path}`),
          "",
          "Next:",
          `- Review ${generated.issuesPath}`,
          `- Re-run: ${state.runCommand ?? "(unknown)"}`,
        ];

        await showAlert("error", "Bug Alert", alertLines.join("\n"));
      } else if (judgeResult.verdict === "unclear") {
        const alertLines: string[] = [
          "Fuzzing found something, but triage is unclear.",
          "",
          `Target: ${plan.target.symbol}`,
          `Verdict: ${judgeResult.verdict}`,
          `Root cause: ${judgeResult.root_cause}`,
          "",
          "Reason:",
          judgeResult.reason.trim().length > 0 ? judgeResult.reason.trim() : "(empty)",
          "",
          "Findings:",
          ...runFindings.slice(0, 10).map((finding) => `- ${finding.kind}: ${finding.path}`),
          "",
          "Next:",
          `- Inspect the crash inputs under ${state.runLibAflOutputDir ?? "(unknown)"}`,
        ];

        await showAlert("warn", "Triage Alert", alertLines.join("\n"));
      }

      redraw();
      return;
    }
  }

  list.on("select", async (_item, index) => {
    lastUserActionAtMs = Date.now();
    lastUserActionIndex = index;

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
        const ok = await buildPlanFlow(selected);
        if (ok) {
          return;
        }

        state.selectedTarget = undefined;
        state.plan = undefined;
        state.draftedHarnessSource = undefined;
        state.step = "target";
        setStatus("Harness generation failed", "Pick a different target.");
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
        stopDriver();
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

  list.on("element click", () => {
    if (inputLocked) {
      return;
    }

    setTimeout(() => {
      const now = Date.now();
      if (inputLocked) {
        return;
      }

      const selectedIndex = currentListIndex();
      if (now - lastUserActionAtMs < 80 && lastUserActionIndex === selectedIndex) {
        return;
      }

      (list as any).enterSelected();
    }, 0);
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

  outputBox.key(["s"], () => {
    requestStopFuzzing();
  });

  harnessBox.key(["s"], () => {
    requestStopFuzzing();
  });

  screen.key(["s"], () => {
    requestStopFuzzing();
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
    stopDriver();
    screen.destroy();
  });

  setStatus("Ready");
  redraw();
  list.focus();
  startDriver();

  await new Promise<void>((resolve) => {
    screen.once("destroy", () => {
      stopDriver();
      resolve();
    });
  });
}
