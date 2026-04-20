import blessed from "blessed";

import { writeCampaign, createFallbackPlan } from "./campaign.js";
import { discoverTargets } from "./discovery.js";
import {
  buildCampaignPlanWithOpenAI,
  isOpenAIReady,
  rankTargetsWithOpenAI,
} from "./openai.js";
import { loadPromptSources } from "./prompts.js";
import type {
  AppConfig,
  CampaignPlan,
  CandidateTarget,
  DiscoveryResult,
  FuzzMode,
  GeneratedCampaign,
  ScopeMode,
} from "./types.js";

type StepName = "mode" | "scope" | "target" | "review" | "result";

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
  generated?: GeneratedCampaign;
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
    description: "Useful when GoSentry can feed composite Go inputs directly.",
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

function pushLog(logBox: blessed.Widgets.Log, message: string): void {
  logBox.add(message);
}

function buildHeader(config: AppConfig, state: AppState): string {
  return [
    " brrrsentry ",
    ` target=${config.targetDir}`,
    ` model=${config.model}/${config.reasoningEffort}`,
    ` openai=${isOpenAIReady(config) ? "on" : "off"}`,
    ` step=${state.step}`,
  ].join(" | ");
}

function renderChoices(list: blessed.Widgets.ListElement, choices: StepChoice[]): void {
  list.setItems(choices.map((choice) => choice.label));
  list.select(0);
}

function renderTargets(
  list: blessed.Widgets.ListElement,
  candidates: CandidateTarget[],
): void {
  list.setItems(
    candidates.map(
      (candidate) =>
        `${candidate.symbol} [${candidate.language}] score=${candidate.score} ${candidate.relativePath}`,
    ),
  );
  list.select(0);
}

function choiceFromIndex<T>(values: T[], index: number): T | undefined {
  return values[index];
}

export async function runTui(config: AppConfig): Promise<void> {
  const prompts = await loadPromptSources(config.repoRoot);
  const state: AppState = { step: "mode" };

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
    tags: false,
    border: "line",
    style: { border: { fg: "cyan" } },
  });

  const main = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "70%",
    bottom: 7,
    border: "line",
    label: " Flow ",
    style: { border: { fg: "green" } },
  });

  const details = blessed.box({
    parent: screen,
    top: 3,
    left: "70%",
    width: "30%",
    bottom: 7,
    border: "line",
    label: " Details / Log ",
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: { border: { fg: "yellow" } },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 7,
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

  const logBox = blessed.log({
    parent: details,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
  });

  function setFooter(text: string): void {
    footer.setContent(text);
  }

  function renderDetails(text: string): void {
    logBox.setContent(text);
  }

  function redraw(): void {
    header.setContent(buildHeader(config, state));

    if (state.step === "mode") {
      renderChoices(list, modeChoices);
      renderDetails(
        modeChoices
          .map((choice, index) => `${index + 1}. ${choice.label}\n${choice.description}`)
          .join("\n\n"),
      );
      setFooter("Arrows + Enter: choose fuzz mode | q: quit");
    } else if (state.step === "scope") {
      renderChoices(list, scopeChoices);
      renderDetails(
        scopeChoices
          .map((choice, index) => `${index + 1}. ${choice.label}\n${choice.description}`)
          .join("\n\n"),
      );
      setFooter("Arrows + Enter: choose scope mode | q: quit");
    } else if (state.step === "target" && state.discovery) {
      renderTargets(list, state.discovery.recommended);
      renderDetails(
        [
          ...state.discovery.notes,
          "",
          ...state.discovery.recommended.map(
            (candidate, index) =>
              `${index + 1}. ${candidate.symbol}\n${candidate.signature}\n${candidate.relativePath}\n${candidate.reasons.join(", ")}`,
          ),
        ].join("\n\n"),
      );
      setFooter("Arrows + Enter: choose discovered target | q: quit");
    } else if (state.step === "review" && state.plan) {
      const actions: StepChoice[] = [
        {
          key: "generate",
          label: "Generate campaign files",
          description: "Write the campaign under .brrrsentry/",
        },
      ];
      renderChoices(list, actions);
      renderDetails(
        [
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
      setFooter("Enter: generate files | q: quit");
    } else if (state.step === "result" && state.generated) {
      const actions: StepChoice[] = [
        {
          key: "done",
          label: "Done",
          description: "Exit the TUI",
        },
      ];
      renderChoices(list, actions);
      renderDetails(
        [
          `Campaign root: ${state.generated.rootDir}`,
          `FUZZ.md: ${state.generated.fuzzDocPath}`,
          `FOUND_ISSUES.md: ${state.generated.issuesPath}`,
          `fuzz.bash: ${state.generated.fuzzScriptPath}`,
          `Harness: ${state.generated.harnessPath}`,
          "",
          "The app did not auto-run the campaign. That is intentional.",
        ].join("\n"),
      );
      setFooter("Enter or q: exit");
    }

    screen.render();
  }

  async function runDiscoveryFlow(): Promise<void> {
    pushLog(logBox, "Scanning target directory...");
    state.discovery = await discoverTargets(config.targetDir);
    pushLog(logBox, `Static candidates found: ${state.discovery.candidates.length}`);

    if (isOpenAIReady(config) && state.discovery.candidates.length > 0) {
      pushLog(logBox, "Ranking candidates with OpenAI...");
      try {
        const ranked = await rankTargetsWithOpenAI(config, state.discovery, prompts);
        const chosen = ranked.recommendedIds
          .map((id) => state.discovery?.candidates.find((candidate) => candidate.id === id))
          .filter((candidate): candidate is CandidateTarget => candidate !== undefined);
        if (chosen.length > 0) {
          state.discovery.recommended = chosen;
        }
        for (const note of ranked.notes) {
          pushLog(logBox, `OpenAI: ${note}`);
        }
      } catch (error) {
        pushLog(logBox, `OpenAI ranking failed: ${(error as Error).message}`);
      }
    }

    state.step = "target";
    redraw();
  }

  async function buildPlanFlow(target: CandidateTarget): Promise<void> {
    if (!state.fuzzMode || !state.scopeMode) {
      throw new Error("wizard state is incomplete");
    }

    pushLog(logBox, `Building campaign plan for ${target.symbol}...`);

    let plan = createFallbackPlan(target, state.fuzzMode, state.scopeMode);

    if (isOpenAIReady(config)) {
      try {
        const enriched = await buildCampaignPlanWithOpenAI(
          config,
          prompts,
          target,
          state.fuzzMode,
          state.scopeMode,
        );
        plan = {
          ...plan,
          ...enriched,
        };
      } catch (error) {
        pushLog(logBox, `OpenAI planning failed: ${(error as Error).message}`);
      }
    }

    state.plan = plan;
    state.step = "review";
    redraw();
  }

  async function generateFlow(): Promise<void> {
    if (!state.plan) {
      throw new Error("campaign plan is missing");
    }

    pushLog(logBox, "Writing campaign workspace...");
    state.generated = await writeCampaign(
      config,
      state.plan,
      state.discovery?.moduleName,
    );
    state.step = "result";
    redraw();
  }

  list.on("select", async (_item, index) => {
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

      if (state.step === "result") {
        screen.destroy();
      }
    } catch (error) {
      pushLog(logBox, `Error: ${(error as Error).message}`);
      screen.render();
    }
  });

  screen.key(["q", "C-c"], () => {
    screen.destroy();
  });

  redraw();
  list.focus();
}

