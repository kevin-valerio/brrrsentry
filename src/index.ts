import fs from "node:fs/promises";

import { parseArgs } from "./args.js";
import { runTui } from "./tui.js";

async function ensureTargetExists(targetDir: string): Promise<void> {
  const stat = await fs.stat(targetDir);
  if (!stat.isDirectory()) {
    throw new Error(`Target path is not a directory: ${targetDir}`);
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  await ensureTargetExists(config.targetDir);
  await runTui(config);
}

main().catch((error) => {
  process.stderr.write(`brrrsentry failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
