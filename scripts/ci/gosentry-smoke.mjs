import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildReadyGoHarness, createFallbackPlan, writeCampaign } from "../../dist/campaign.js";
import { spawnStreaming } from "../../dist/process.js";

async function makeTempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeBuggyGoTarget(targetDir) {
  const moduleName = "example.com/brrrsentry-ci-fixture";
  const pkg = "brrrsentryfixture";
  const fileName = "fixture.go";
  const symbol = "CrashOnSeed";
  const filePath = path.join(targetDir, fileName);

  await fs.writeFile(
    path.join(targetDir, "go.mod"),
    `module ${moduleName}\n\ngo 1.23\n`,
  );
  await fs.writeFile(
    filePath,
    [
      `package ${pkg}`,
      "",
      "import \"bytes\"",
      "",
      "var seedCrash = []byte(\"{}\")",
      "",
      `func ${symbol}(data []byte) ([]byte, error) {`,
      "  // Deliberate bug for CI: crashes on the default harness seed input.",
      "  if bytes.Equal(data, seedCrash) {",
      "    panic(\"boom\")",
      "  }",
      "  return data, nil",
      "}",
      "",
    ].join("\n"),
  );

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

async function main() {
  const repoRoot = process.cwd();
  const targetDir = await makeTempDir("brrrsentry-ci-target-");

  const gosentryPath = path.resolve(repoRoot, "third_party/gosentry");
  const targetMeta = await writeBuggyGoTarget(targetDir);

  const candidate = {
    id: "ci-fixture-1",
    language: "go",
    filePath: targetMeta.filePath,
    relativePath: targetMeta.relativePath,
    moduleName: targetMeta.moduleName,
    moduleRoot: targetMeta.moduleRoot,
    symbol: targetMeta.symbol,
    signature: targetMeta.signature,
    kind: "function",
    score: 100,
    reasons: ["CI fixture: crash on seed"],
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

  const config = {
    repoRoot,
    targetDir,
    gosentryPath,
    model: "gpt-5.2",
    reasoningEffort: "xhigh",
  };

  const plan = createFallbackPlan(candidate, "byte", "narrow");
  const harnessSource = buildReadyGoHarness(plan);
  const generated = await writeCampaign(config, plan, {
    moduleName: candidate.moduleName,
    moduleRoot: candidate.moduleRoot,
  }, harnessSource);

  const libAflPattern = /^libafl output dir:\s*(.+)$/i;
  let libAflOutputDir = null;

  const outputTail = [];
  const run = spawnStreaming("./fuzz.bash", [], {
    cwd: generated.rootDir,
    env: {
      ...process.env,
      CORES: "0",
      GOSENTRY_ROOT: gosentryPath,
    },
    onLine: (line) => {
      outputTail.push(line);
      if (outputTail.length > 200) {
        outputTail.shift();
      }
      const match = line.match(libAflPattern);
      if (match?.[1]) {
        libAflOutputDir = match[1].trim();
      }
    },
  });

  const timeoutMs = 60_000;
  const timeout = setTimeout(() => {
    try {
      run.child.kill("SIGINT");
    } catch {
      // ignore
    }
  }, timeoutMs);

  const result = await run.completion.finally(() => clearTimeout(timeout));

  if (!libAflOutputDir) {
    throw new Error(
      [
        "gosentry run finished, but libafl output dir was not detected in output.",
        "",
        "Output (tail):",
        ...outputTail,
        "",
        `Exit: ${result.exitCode ?? "?"} signal=${result.signal ?? "none"}`,
      ].join("\n"),
    );
  }

  const crashesDir = path.join(libAflOutputDir, "crashes");
  let crashes = [];
  try {
    crashes = (await fs.readdir(crashesDir)).filter((name) => !name.startsWith("."));
  } catch {
    // ignore
  }

  if (crashes.length === 0) {
    throw new Error(
      [
        "Expected at least one crash file, but found none.",
        "",
        `libafl output: ${libAflOutputDir}`,
        "",
        "Output (tail):",
        ...outputTail,
      ].join("\n"),
    );
  }

  process.stdout.write(
    [
      "CI gosentry smoke: OK",
      `Campaign: ${generated.rootDir}`,
      `libafl output: ${libAflOutputDir}`,
      `crashes: ${crashes.slice(0, 5).join(", ")}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`gosentry smoke failed: ${(error?.message ?? String(error)).trim()}\n`);
  process.exitCode = 1;
});

