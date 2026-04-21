import path from "node:path";
import { Command } from "commander";

import type { AppConfig, ReasoningEffort } from "./types.js";

export function parseArgs(argv: string[]): AppConfig {
  const program = new Command();

  program
    .name("brrrsentry")
    .description("Agentic gosentry campaign generator")
    .argument("<targetDir>", "directory to fuzz")
    .option("--gosentry-path <path>", "override the gosentry root path")
    .option("--model <model>", "model for discovery and planning", "gpt-5.2")
    .option(
      "--reasoning-effort <effort>",
      "reasoning effort (low|medium|high|xhigh)",
      "xhigh",
    );

  program.parse(argv);

  const [targetDirArg] = program.args;
  const options = program.opts<{
    gosentryPath?: string;
    model: string;
    reasoningEffort: string;
  }>();

  if (!targetDirArg) {
    throw new Error("targetDir is required");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const repoRoot = process.cwd();
  const targetDir = path.resolve(targetDirArg);
  const gosentryPath = path.resolve(
    options.gosentryPath ?? path.join(repoRoot, "third_party/gosentry"),
  );

  return {
    repoRoot,
    targetDir,
    gosentryPath,
    model: options.model,
    reasoningEffort: options.reasoningEffort as ReasoningEffort,
  };
}
