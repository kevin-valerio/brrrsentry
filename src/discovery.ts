import fs from "node:fs/promises";
import path from "node:path";

import { runExecFile, tryExecFile } from "./process.js";
import type { CandidateTarget, DiscoveryResult, TargetLanguage } from "./types.js";

interface GoModuleInfo {
  moduleName?: string;
  moduleRoot?: string;
}

function scoreSymbol(symbol: string, relativePath: string): { score: number; reasons: string[]; kind: string } {
  const loweredSymbol = symbol.toLowerCase();
  const loweredPath = relativePath.toLowerCase();
  const reasons: string[] = [];
  let score = 10;
  let kind = "entrypoint";

  const kindMatchers: Array<[RegExp, string, number, string]> = [
    [/parse|decode|unmarshal|lex/, "parser", 20, "parser-like symbol"],
    [/marshal|encode|serialize/, "encoder", 14, "encoder-like symbol"],
    [/verify|validate|check/, "validator", 16, "validator-like symbol"],
    [/process|handle|execute|apply|eval|compile/, "logic", 12, "logic-heavy symbol"],
    [/read|load|import/, "reader", 10, "reader-like symbol"],
  ];

  for (const [matcher, matchedKind, bonus, reason] of kindMatchers) {
    if (matcher.test(loweredSymbol)) {
      score += bonus;
      kind = matchedKind;
      reasons.push(reason);
      break;
    }
  }

  if (/(json|yaml|xml|toml|parser|codec|proto|wire|abi|rlp|ssz|cbor)/.test(loweredPath)) {
    score += 10;
    reasons.push("format or parser path");
  }

  if (/(http|rpc|api|request|response|state|consensus|tx|block|proof)/.test(loweredPath)) {
    score += 8;
    reasons.push("protocol or state path");
  }

  if (/(vendor|third_party|testdata|examples|example)/.test(loweredPath)) {
    score -= 16;
    reasons.push("less interesting path");
  }

  return { score, reasons, kind };
}

async function findGoModuleInfo(targetDir: string): Promise<GoModuleInfo> {
  let currentDir = path.resolve(targetDir);

  while (true) {
    const goModPath = path.join(currentDir, "go.mod");
    try {
      const content = await fs.readFile(goModPath, "utf8");
      const firstLine = content
        .split(/\r?\n/)
        .find((line) => line.startsWith("module "));
      return {
        moduleName: firstLine?.replace(/^module\s+/, "").trim(),
        moduleRoot: currentDir,
      };
    } catch {
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        return {};
      }
      currentDir = parentDir;
    }
  }
}

async function readPackageName(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const match = content.match(/^package\s+([A-Za-z_][A-Za-z0-9_]*)$/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function parseGoCandidate(
  rawLine: string,
  targetDir: string,
  module: GoModuleInfo,
): CandidateTarget | null {
  const match = rawLine.match(/^(.*?):(\d+):(.*)$/);
  if (!match) {
    return null;
  }

  const filePath = match[1];
  const signature = match[3];
  if (!filePath || !signature) {
    return null;
  }
  const funcMatch = signature.match(
    /func\s+(\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\((.*?)\)/,
  );
  if (!funcMatch) {
    return null;
  }

  const receiver = funcMatch[1];
  const symbol = funcMatch[2];
  const args = funcMatch[3];
  if (!symbol || args === undefined) {
    return null;
  }
  const argCount =
    args.trim() === ""
      ? 0
      : args
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean).length;
  const relativePath = path.relative(targetDir, filePath);
  const scored = scoreSymbol(symbol, relativePath);
  const packageDir = path.dirname(filePath);
  const importPath =
    module.moduleName && module.moduleRoot
      ? `${module.moduleName}${path
          .relative(module.moduleRoot, packageDir)
          .split(path.sep)
          .filter(Boolean)
          .map((part) => `/${part}`)
          .join("")}`
      : undefined;

  return {
    id: `go:${relativePath}:${symbol}`,
    language: "go",
    filePath,
    relativePath,
    symbol,
    signature: signature.trim(),
    kind: scored.kind,
    score: scored.score,
    reasons: scored.reasons,
    importPath,
    hasReceiver: Boolean(receiver),
    isExported: /^[A-Z]/.test(symbol),
    acceptsBytes: /\[\]byte/.test(args),
    acceptsString: /\bstring\b/.test(args),
    argCount,
  };
}

function parseRegexCandidates(
  rawOutput: string,
  targetDir: string,
  language: TargetLanguage,
): CandidateTarget[] {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates: CandidateTarget[] = [];

  for (const rawLine of lines) {
    const match = rawLine.match(/^(.*?):(\d+):(.*)$/);
    if (!match) {
      continue;
    }
    const filePath = match[1];
    const code = match[3];
    if (!filePath || !code) {
      continue;
    }
    const symbolMatch = code.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!symbolMatch) {
      continue;
    }
    const symbol = symbolMatch[1];
    if (!symbol) {
      continue;
    }
    const relativePath = path.relative(targetDir, filePath);
    const scored = scoreSymbol(symbol, relativePath);

    candidates.push({
      id: `${language}:${relativePath}:${symbol}`,
      language,
      filePath,
      relativePath,
      symbol,
      signature: code.trim(),
      kind: scored.kind,
      score: scored.score,
      reasons: scored.reasons,
    });
  }

  return candidates;
}

export async function discoverTargets(targetDir: string): Promise<DiscoveryResult> {
  const moduleInfo = await findGoModuleInfo(targetDir);
  const notes: string[] = [];

  const goMatches = await tryExecFile(
    "rg",
    ["-n", "func\\s+(\\([^)]*\\)\\s*)?[A-Za-z_][A-Za-z0-9_]*\\s*\\(", "--glob", "*.go", targetDir],
    targetDir,
  );
  const rustMatches = await tryExecFile(
    "rg",
    ["-n", "\\bfn\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\(", "--glob", "*.rs", targetDir],
    targetDir,
  );
  const cMatches = await tryExecFile(
    "rg",
    [
      "-n",
      "(?:[A-Za-z_][A-Za-z0-9_<>:*&\\s]+)\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\([^;]*\\)\\s*\\{",
      "--glob",
      "*.{c,h,cc,cpp,hpp}",
      targetDir,
    ],
    targetDir,
  );

  const goCandidates =
    goMatches
      ?.split(/\r?\n/)
      .map((line) => parseGoCandidate(line, targetDir, moduleInfo))
      .filter((candidate): candidate is CandidateTarget => candidate !== null) ?? [];
  const rustCandidates = rustMatches ? parseRegexCandidates(rustMatches, targetDir, "rust") : [];
  const cCandidates = cMatches ? parseRegexCandidates(cMatches, targetDir, "c") : [];

  const enrichedGoCandidates = await Promise.all(
    goCandidates.map(async (candidate) => ({
      ...candidate,
      packageName: await readPackageName(candidate.filePath),
    })),
  );

  const candidates = [...enrichedGoCandidates, ...rustCandidates, ...cCandidates]
    .sort((left, right) => right.score - left.score)
    .slice(0, 40);

  if (candidates.length === 0) {
    notes.push("No fuzz candidates were found with the current static scan.");
  }

  if (!moduleInfo.moduleName) {
    notes.push("No Go module root was found above the target directory.");
  }

  return {
    moduleName: moduleInfo.moduleName,
    moduleRoot: moduleInfo.moduleRoot,
    candidates,
    recommended: candidates.slice(0, 3),
    notes,
  };
}

export async function buildDirectorySummary(targetDir: string): Promise<string[]> {
  const output = await runExecFile(
    "rg",
    ["--files", targetDir, "-g", "*.go", "-g", "*.rs", "-g", "*.c", "-g", "*.cc", "-g", "*.cpp"],
    targetDir,
  ).catch(() => "");

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
}
