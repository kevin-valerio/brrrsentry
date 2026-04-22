import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runTui } from "../dist/tui.js";

async function makeTempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeTuiIo() {
  const input = new PassThrough();
  const output = new PassThrough();

  input.isTTY = true;
  input.setRawMode = () => {};

  output.isTTY = true;
  output.columns = 120;
  output.rows = 40;
  output.getWindowSize = () => [output.columns, output.rows];

  let rawOutput = "";
  output.on("data", (chunk) => {
    rawOutput += chunk.toString("utf8");
  });

  return {
    input,
    output,
    getRawOutput: () => rawOutput,
  };
}

async function writeGoTargetRepo(targetDir, options) {
  const moduleName = options.moduleName;
  const pkg = options.packageName;
  const fileName = options.fileName;
  const symbol = options.symbol;

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, "go.mod"),
    `module ${moduleName}\n\ngo 1.23\n`,
  );
  await fs.writeFile(
    path.join(targetDir, fileName),
    [
      `package ${pkg}`,
      "",
      "import \"errors\"",
      "",
      `func ${symbol}(data []byte) ([]byte, error) {`,
      "  if len(data) == 0 {",
      "    return nil, errors.New(\"empty\")",
      "  }",
      "  return data, nil",
      "}",
      "",
    ].join("\n"),
  );

  const filePath = path.join(targetDir, fileName);
  return {
    moduleName,
    moduleRoot: targetDir,
    packageName: pkg,
    importPath: moduleName,
    relativePath: fileName,
    filePath,
    symbol,
    signature: `func ${symbol}(data []byte) ([]byte, error)`,
  };
}

async function ensureDummyGosentryRoot(rootDir) {
  const binDir = path.join(rootDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "go"), "");
}

async function findSingleCampaignRoot(targetDir) {
  const campaignsRoot = path.join(targetDir, ".brrrsentry", "campaigns");
  const slugs = (await fs.readdir(campaignsRoot)).filter((name) => !name.startsWith("."));
  assert.equal(slugs.length, 1, `Expected 1 campaign dir, got: ${slugs.join(", ")}`);
  return path.join(campaignsRoot, slugs[0]);
}

test("TUI: harness false positive -> auto-fix -> auto-rerun", async () => {
  const repoRoot = process.cwd();
  const targetDir = await makeTempDir("brrrsentry-target-");
  const gosentryPath = await makeTempDir("brrrsentry-gosentry-");
  await ensureDummyGosentryRoot(gosentryPath);

  const targetMeta = await writeGoTargetRepo(targetDir, {
    moduleName: "example.com/brrrsentryfixture",
    packageName: "brrrsentryfixture",
    fileName: "fixture.go",
    symbol: "Decode",
  });

  const candidate = {
    id: "fixture-1",
    language: "go",
    filePath: targetMeta.filePath,
    relativePath: targetMeta.relativePath,
    moduleName: targetMeta.moduleName,
    moduleRoot: targetMeta.moduleRoot,
    symbol: targetMeta.symbol,
    signature: targetMeta.signature,
    kind: "function",
    score: 80,
    reasons: ["fixture"],
    packageName: targetMeta.packageName,
    importPath: targetMeta.importPath,
    hasReceiver: false,
    isExported: true,
    acceptsBytes: true,
    acceptsString: false,
    acceptsContext: false,
    argCount: 1,
    fuzzInputArgIndex: 0,
    fuzzInputKind: "bytes",
  };

  const io = makeTuiIo();
  let fuzzRuns = 0;
  let libAflOutDir = null;
  const fixedHarnessSource = "package fuzzcampaign\n\n// FIXED HARNESS\n";

  const services = {
    buildRepositoryDiscoveryContext: async () => {
      return {
        moduleName: targetMeta.moduleName,
        moduleRoot: targetMeta.moduleRoot,
        totalFiles: 1,
        inventory: [{ relativePath: targetMeta.relativePath, score: 1, reasons: ["fixture"] }],
        previews: [
          {
            relativePath: targetMeta.relativePath,
            score: 1,
            reasons: ["fixture"],
            content: "package brrrsentryfixture\n",
          },
        ],
        notes: [],
      };
    },
    discoverTargetsWithOpenAI: async () => {
      return {
        moduleName: targetMeta.moduleName,
        moduleRoot: targetMeta.moduleRoot,
        candidates: [candidate],
        recommended: [candidate],
        notes: [],
      };
    },
    buildCampaignPlanWithOpenAI: async () => {
      return {
        title: "fixture plan",
        oracleStrategy: "fixture",
        harnessStrategy: "fixture",
        grammarSummary: "fixture",
        corpusIdeas: ["fixture"],
        panicOnCandidates: [],
        reportExpectations: ["fixture"],
      };
    },
    autoJudgeFindingWithOpenAI: async () => {
      return {
        verdict: "false_positive",
        root_cause: "harness",
        reason: "harness bug",
        fixed_harness_source: fixedHarnessSource,
      };
    },
    spawnStreaming: (_file, _args, opts) => {
      const file = String(_file);
      if (file === "./fuzz.bash") {
        fuzzRuns += 1;
        if (!libAflOutDir) {
          libAflOutDir = path.join(opts.cwd, "libafl-out");
        }
        opts.onLine?.(`libafl output dir: ${libAflOutDir}`);

        const completion =
          fuzzRuns === 1
            ? (async () => {
                const crashDir = path.join(libAflOutDir, "crashes");
                await fs.mkdir(crashDir, { recursive: true });
                await fs.writeFile(path.join(crashDir, "id_000000"), "boom");
                return { exitCode: 0, signal: null };
              })()
            : Promise.resolve({ exitCode: 0, signal: null });
        return {
          child: { kill: () => {} },
          completion,
        };
      }

      return {
        child: { kill: () => {} },
        completion: Promise.resolve({ exitCode: 0, signal: null }),
      };
    },
  };

  await runTui(
    {
      repoRoot,
      targetDir,
      gosentryPath,
      model: "gpt-5.2",
      reasoningEffort: "low",
    },
    {
      io,
      services,
      driver: {
        fuzzMode: "byte",
        scopeMode: "narrow",
        targetIndex: 0,
        afterResult: "run",
        runCores: "1",
        quitAfterRun: true,
        dismissAlerts: true,
      },
    },
  );

  assert.equal(fuzzRuns, 2, "Expected fuzz to run twice (auto-rerun after fix).");

  const campaignRoot = await findSingleCampaignRoot(targetDir);
  const harnessDir = path.join(campaignRoot, "harness");
  const harnessFiles = (await fs.readdir(harnessDir)).filter((name) => name.endsWith("_test.go"));
  assert.equal(harnessFiles.length, 1, "Expected exactly one harness _test.go file.");
  const harnessPath = path.join(harnessDir, harnessFiles[0]);

  const harnessContent = await fs.readFile(harnessPath, "utf8");
  assert.ok(
    harnessContent.includes("FIXED HARNESS"),
    "Expected fixed harness source to be written.",
  );
});

test("TUI: real bug -> records FOUND_ISSUES.md + shows alert", async () => {
  const repoRoot = process.cwd();
  const targetDir = await makeTempDir("brrrsentry-target-");
  const gosentryPath = await makeTempDir("brrrsentry-gosentry-");
  await ensureDummyGosentryRoot(gosentryPath);

  const targetMeta = await writeGoTargetRepo(targetDir, {
    moduleName: "example.com/brrrsentryfixture2",
    packageName: "brrrsentryfixture2",
    fileName: "fixture.go",
    symbol: "Decode",
  });

  const candidate = {
    id: "fixture-2",
    language: "go",
    filePath: targetMeta.filePath,
    relativePath: targetMeta.relativePath,
    moduleName: targetMeta.moduleName,
    moduleRoot: targetMeta.moduleRoot,
    symbol: targetMeta.symbol,
    signature: targetMeta.signature,
    kind: "function",
    score: 80,
    reasons: ["fixture"],
    packageName: targetMeta.packageName,
    importPath: targetMeta.importPath,
    hasReceiver: false,
    isExported: true,
    acceptsBytes: true,
    acceptsString: false,
    acceptsContext: false,
    argCount: 1,
    fuzzInputArgIndex: 0,
    fuzzInputKind: "bytes",
  };

  const io = makeTuiIo();
  let libAflOutDir = null;

  const services = {
    buildRepositoryDiscoveryContext: async () => {
      return {
        moduleName: targetMeta.moduleName,
        moduleRoot: targetMeta.moduleRoot,
        totalFiles: 1,
        inventory: [{ relativePath: targetMeta.relativePath, score: 1, reasons: ["fixture"] }],
        previews: [
          {
            relativePath: targetMeta.relativePath,
            score: 1,
            reasons: ["fixture"],
            content: "package brrrsentryfixture2\n",
          },
        ],
        notes: [],
      };
    },
    discoverTargetsWithOpenAI: async () => {
      return {
        moduleName: targetMeta.moduleName,
        moduleRoot: targetMeta.moduleRoot,
        candidates: [candidate],
        recommended: [candidate],
        notes: [],
      };
    },
    buildCampaignPlanWithOpenAI: async () => {
      return {
        title: "fixture plan",
        oracleStrategy: "fixture",
        harnessStrategy: "fixture",
        grammarSummary: "fixture",
        corpusIdeas: ["fixture"],
        panicOnCandidates: [],
        reportExpectations: ["fixture"],
      };
    },
    autoJudgeFindingWithOpenAI: async () => {
      return {
        verdict: "real_bug",
        root_cause: "target",
        reason: "Looks like a real bug in the target.",
      };
    },
    spawnStreaming: (_file, _args, opts) => {
      const file = String(_file);
      if (file === "./fuzz.bash") {
        if (!libAflOutDir) {
          libAflOutDir = path.join(opts.cwd, "libafl-out");
        }
        opts.onLine?.(`libafl output dir: ${libAflOutDir}`);
        const completion = (async () => {
          const crashDir = path.join(libAflOutDir, "crashes");
          await fs.mkdir(crashDir, { recursive: true });
          await fs.writeFile(path.join(crashDir, "id_000000"), "boom");
          return { exitCode: 0, signal: null };
        })();
        return {
          child: { kill: () => {} },
          completion,
        };
      }

      return {
        child: { kill: () => {} },
        completion: Promise.resolve({ exitCode: 0, signal: null }),
      };
    },
  };

  let sawAlert = false;
  let alertTitle = "";

  await runTui(
    {
      repoRoot,
      targetDir,
      gosentryPath,
      model: "gpt-5.2",
      reasoningEffort: "low",
    },
    {
      io,
      services,
      driver: {
        fuzzMode: "byte",
        scopeMode: "narrow",
        targetIndex: 0,
        afterResult: "run",
        runCores: "1",
        quitAfterRun: true,
        dismissAlerts: true,
      },
      hooks: {
        onAlert: (alert) => {
          sawAlert = true;
          alertTitle = alert.title;
        },
      },
    },
  );

  const campaignRoot = await findSingleCampaignRoot(targetDir);
  const issuesPath = path.join(campaignRoot, "FOUND_ISSUES.md");
  const issuesText = await fs.readFile(issuesPath, "utf8");
  assert.ok(issuesText.includes("verdict: real_bug"), "Expected verdict recorded.");

  assert.ok(sawAlert, "Expected an alert to be shown.");
  assert.equal(alertTitle, "Bug Alert", "Expected the Bug Alert modal.");
});
