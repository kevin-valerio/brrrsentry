import fs from "node:fs/promises";
import path from "node:path";

import { runExecFile } from "./process.js";
import type {
  CandidateTarget,
  DiscoveryResult,
  RepositoryDiscoveryContext,
  RepositoryDiscoveryFile,
  TargetLanguage,
} from "./types.js";

interface GoModuleInfo {
  moduleName?: string;
  moduleRoot?: string;
}

export interface DiscoveredTargetDraft {
  relative_path?: string;
  symbol?: string;
  signature?: string;
  language?: string;
  kind?: string;
  score?: number;
  reasons?: string[];
}

const INVENTORY_LIMIT = 160;
const PREVIEW_LIMIT = 28;
const PREVIEW_LINE_LIMIT = 80;
const PREVIEW_CHAR_LIMIT = 2200;

function normalizeRepoPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function scorePath(relativePath: string): { score: number; reasons: string[] } {
  const loweredPath = relativePath.toLowerCase();
  const baseName = path.basename(loweredPath);
  const reasons: string[] = [];
  let score = 10;

  if (/(json|yaml|xml|toml|parser|codec|proto|wire|abi|rlp|ssz|cbor)/.test(loweredPath)) {
    score += 10;
    reasons.push("format or parser path");
  }

  if (/(http|rpc|api|request|response|state|consensus|tx|block|proof)/.test(loweredPath)) {
    score += 8;
    reasons.push("protocol or state path");
  }

  if (/(parse|decode|unmarshal|verify|validate|check|process|handle|execute|apply|eval|compile)/.test(loweredPath)) {
    score += 10;
    reasons.push("entrypoint-like path");
  }

  if (/^(readme\.md|go\.mod|cargo\.toml|package\.json|pyproject\.toml|pom\.xml|build\.gradle|cmakelists\.txt|makefile)$/i.test(baseName)) {
    score += 6;
    reasons.push("repo overview or build file");
  }

  if (/(^|\/)(test|tests|spec|specs|fixture|fixtures|example|examples|docs|doc|testdata)(\/|$)/.test(loweredPath)) {
    score -= 12;
    reasons.push("test, example, or docs path");
  }

  if (/(third_party)/.test(loweredPath)) {
    score -= 16;
    reasons.push("vendored or external path");
  }

  return { score, reasons };
}

function shouldIgnorePath(relativePath: string): boolean {
  const loweredPath = relativePath.toLowerCase();
  return /(^|\/)(\.git|\.brrrsentry|node_modules|dist|build|coverage|vendor|target|out|bin|obj)(\/|$)/.test(
    loweredPath,
  );
}

function isPriorityContextFile(relativePath: string): boolean {
  const baseName = path.basename(relativePath).toLowerCase();
  return /^(readme\.md|go\.mod|cargo\.toml|package\.json|pyproject\.toml|pom\.xml|build\.gradle|cmakelists\.txt|makefile)$/.test(
    baseName,
  );
}

async function readTextPreview(filePath: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) {
      return null;
    }

    const text = buffer.toString("utf8").replace(/\r/g, "").trim();
    if (text.length === 0) {
      return null;
    }

    const preview = text
      .split("\n")
      .map((line) => line.slice(0, 160))
      .slice(0, PREVIEW_LINE_LIMIT)
      .join("\n")
      .slice(0, PREVIEW_CHAR_LIMIT)
      .trim();

    return preview.length > 0 ? preview : null;
  } catch {
    return null;
  }
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

function buildGoImportPath(
  filePath: string,
  module: GoModuleInfo,
): string | undefined {
  if (!module.moduleName || !module.moduleRoot) {
    return undefined;
  }

  const packageDir = path.dirname(filePath);
  return `${module.moduleName}${path
    .relative(module.moduleRoot, packageDir)
    .split(path.sep)
    .filter(Boolean)
    .map((part) => `/${part}`)
    .join("")}`;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferLanguageFromPath(relativePath: string): TargetLanguage {
  const loweredPath = relativePath.toLowerCase();

  if (loweredPath.endsWith(".go")) return "go";
  if (loweredPath.endsWith(".rs")) return "rust";
  if (/\.(c|h)$/.test(loweredPath)) return "c";
  if (/\.(cc|cpp|cxx|hpp|hxx)$/.test(loweredPath)) return "cpp";
  if (loweredPath.endsWith(".py")) return "python";
  if (/\.(ts|tsx)$/.test(loweredPath)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(loweredPath)) return "javascript";
  if (loweredPath.endsWith(".java")) return "java";
  if (loweredPath.endsWith(".kt")) return "kotlin";
  if (loweredPath.endsWith(".swift")) return "swift";
  if (loweredPath.endsWith(".rb")) return "ruby";
  if (loweredPath.endsWith(".php")) return "php";
  if (loweredPath.endsWith(".cs")) return "csharp";
  if (loweredPath.endsWith(".scala")) return "scala";
  if (loweredPath.endsWith(".sol")) return "solidity";
  if (loweredPath.endsWith(".zig")) return "zig";

  const extension = path.extname(loweredPath).replace(/^\./, "");
  return extension.length > 0 ? extension : "unknown";
}

function parseGoMetadata(
  fileContent: string,
  symbol: string,
): Partial<CandidateTarget> {
  const matcher = fileContent.match(
    new RegExp(
      `func\\s+(\\([^)]*\\)\\s*)?${escapeRegExp(symbol)}\\s*\\(([^)]*)\\)`,
      "m",
    ),
  );
  if (!matcher) {
    return {
      isExported: /^[A-Z]/.test(symbol),
    };
  }

  const receiver = matcher[1];
  const args = matcher[2] ?? "";
  const argCount =
    args.trim() === ""
      ? 0
      : args
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean).length;

  return {
    signature: matcher[0].replace(/\s+/g, " ").trim(),
    hasReceiver: Boolean(receiver),
    isExported: /^[A-Z]/.test(symbol),
    acceptsBytes: /\[\]byte/.test(args),
    acceptsString: /\bstring\b/.test(args),
    argCount,
  };
}

function normalizeRelativeCandidatePath(
  rawRelativePath: string | undefined,
): string | null {
  if (!rawRelativePath) {
    return null;
  }

  const trimmed = rawRelativePath.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return normalizeRepoPath(path.normalize(trimmed.replace(/^\.?[\\/]+/, "")));
}

function normalizeCandidateReasons(
  rawReasons: string[] | undefined,
  fallbackReasons: string[],
): string[] {
  const reasons =
    rawReasons
      ?.map((reason) => reason.trim())
      .filter((reason) => reason.length > 0) ?? [];

  if (reasons.length > 0) {
    return reasons;
  }
  if (fallbackReasons.length > 0) {
    return fallbackReasons;
  }
  return ["model-selected target"];
}

async function enrichGoCandidate(
  candidate: CandidateTarget,
  module: GoModuleInfo,
): Promise<CandidateTarget> {
  const packageName = await readPackageName(candidate.filePath);

  let parsedMetadata: Partial<CandidateTarget> = {
    isExported: /^[A-Z]/.test(candidate.symbol),
  };

  try {
    const content = await fs.readFile(candidate.filePath, "utf8");
    parsedMetadata = parseGoMetadata(content, candidate.symbol);
  } catch {
    // keep the candidate as manual-only if local parsing fails
  }

  return {
    ...candidate,
    ...parsedMetadata,
    packageName,
    importPath: buildGoImportPath(candidate.filePath, module),
  };
}

async function hydrateCandidateTarget(
  rawTarget: DiscoveredTargetDraft,
  index: number,
  targetDir: string,
  module: GoModuleInfo,
  inventoryByPath: Map<string, RepositoryDiscoveryFile>,
): Promise<CandidateTarget | null> {
  const candidatePath = normalizeRelativeCandidatePath(rawTarget.relative_path);
  const symbol = rawTarget.symbol?.trim();

  if (!candidatePath || !symbol) {
    return null;
  }

  const targetRoot = path.resolve(targetDir);
  const filePath = path.resolve(targetDir, candidatePath);
  if (
    filePath !== targetRoot &&
    !filePath.startsWith(`${targetRoot}${path.sep}`)
  ) {
    return null;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const relativePath = normalizeRepoPath(path.relative(targetDir, filePath));
  const inventoryMatch = inventoryByPath.get(relativePath);
  const normalizedLanguage =
    rawTarget.language?.trim().toLowerCase() || inferLanguageFromPath(relativePath);
  const fallbackScore = Math.max(12, 100 - index * 7);
  const rawScore =
    typeof rawTarget.score === "number" && Number.isFinite(rawTarget.score)
      ? rawTarget.score
      : inventoryMatch?.score ?? fallbackScore;

  const baseCandidate: CandidateTarget = {
    id: `${normalizedLanguage}:${relativePath}:${symbol}`,
    language: normalizedLanguage,
    filePath,
    relativePath,
    symbol,
    signature: rawTarget.signature?.trim() || symbol,
    kind: rawTarget.kind?.trim() || "entrypoint",
    score: Math.max(0, Math.round(rawScore)),
    reasons: normalizeCandidateReasons(rawTarget.reasons, inventoryMatch?.reasons ?? []),
  };

  if (normalizedLanguage !== "go") {
    return baseCandidate;
  }

  return await enrichGoCandidate(baseCandidate, module);
}

export async function buildRepositoryDiscoveryContext(
  targetDir: string,
  callbacks?: { onProgress?: (message: string) => void },
): Promise<RepositoryDiscoveryContext> {
  const moduleInfo = await findGoModuleInfo(targetDir);
  const notes: string[] = [];

  callbacks?.onProgress?.("Listing repository files");
  const rawFiles = await runExecFile("rg", ["--files"], targetDir);
  const relativePaths = rawFiles
    .split(/\r?\n/)
    .map((line) => normalizeRepoPath(line.trim()))
    .filter(Boolean)
    .filter((relativePath) => !shouldIgnorePath(relativePath));

  const inventory = relativePaths
    .map((relativePath) => {
      const scored = scorePath(relativePath);
      return {
        relativePath,
        score: scored.score,
        reasons: scored.reasons,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.relativePath.localeCompare(right.relativePath),
    )
    .slice(0, INVENTORY_LIMIT);

  callbacks?.onProgress?.("Reading repository previews for model discovery");
  const inventoryByPath = new Map(inventory.map((item) => [item.relativePath, item]));
  const previewPaths = Array.from(
    new Set([
      ...inventory.filter((item) => isPriorityContextFile(item.relativePath)).map((item) => item.relativePath),
      ...inventory.map((item) => item.relativePath),
    ]),
  ).slice(0, PREVIEW_LIMIT);

  const previews = (
    await Promise.all(
      previewPaths.map(async (relativePath) => {
        const inventoryItem = inventoryByPath.get(relativePath);
        if (!inventoryItem) {
          return null;
        }

        const content = await readTextPreview(path.join(targetDir, relativePath));
        if (!content) {
          return null;
        }

        return {
          ...inventoryItem,
          content,
        };
      }),
    )
  ).filter((preview): preview is RepositoryDiscoveryContext["previews"][number] => preview !== null);

  if (relativePaths.length === 0) {
    notes.push("No repository files were found under the selected target directory.");
  }

  if (previews.length === 0) {
    notes.push("No readable source previews were found for agentic discovery.");
  }

  return {
    moduleName: moduleInfo.moduleName,
    moduleRoot: moduleInfo.moduleRoot,
    totalFiles: relativePaths.length,
    inventory,
    previews,
    notes,
  };
}

export async function hydrateDiscoveredTargets(
  targetDir: string,
  context: RepositoryDiscoveryContext,
  rawTargets: DiscoveredTargetDraft[],
): Promise<DiscoveryResult> {
  const inventoryByPath = new Map(context.inventory.map((item) => [item.relativePath, item]));
  const moduleInfo: GoModuleInfo = {
    moduleName: context.moduleName,
    moduleRoot: context.moduleRoot,
  };

  const hydrated = await Promise.all(
    rawTargets.map((rawTarget, index) =>
      hydrateCandidateTarget(rawTarget, index, targetDir, moduleInfo, inventoryByPath),
    ),
  );

  const uniqueCandidates: CandidateTarget[] = [];
  const seenIds = new Set<string>();
  for (const candidate of hydrated) {
    if (!candidate || seenIds.has(candidate.id)) {
      continue;
    }
    seenIds.add(candidate.id);
    uniqueCandidates.push(candidate);
  }

  const candidates = uniqueCandidates.slice(0, 12);
  const notes = [...context.notes];

  if (candidates.length === 0) {
    notes.push("No fuzz candidates were returned by the agentic discovery step.");
  }

  if (candidates.some((candidate) => candidate.language === "go") && !context.moduleName) {
    notes.push(
      "No Go module root was found above the target directory. Auto-wired Go harnesses may be unavailable.",
    );
  }

  return {
    moduleName: context.moduleName,
    moduleRoot: context.moduleRoot,
    candidates,
    recommended: candidates.slice(0, 3),
    notes,
  };
}
