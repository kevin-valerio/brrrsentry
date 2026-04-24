import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";

import { runTui } from "../../dist/tui.js";

function createNullWritable() {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  (sink).isTTY = true;
  (sink).columns = 120;
  (sink).rows = 40;

  return sink;
}

async function makeTempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test(
  "e2e: panic-bug -> byte/narrow -> run -> Bug Alert",
  { timeout: 20 * 60_000 },
  async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for E2E tests");
    }

    const repoRoot = process.cwd();
    const fixtureRoot = path.resolve(repoRoot, "tests", "smoke", "panic-bug");
    const tempRoot = await makeTempDir("brrrsentry-e2e-");
    const targetDir = path.join(tempRoot, "target");

    try {
      await fs.cp(fixtureRoot, targetDir, { recursive: true });

      const input = new PassThrough();
      (input).isTTY = true;
      (input).setRawMode = () => {};
      input.resume();

      const output = createNullWritable();

      const alerts = [];

      await runTui(
        {
          repoRoot,
          targetDir,
          gosentryPath: path.resolve(repoRoot, "third_party", "gosentry"),
          model: "gpt-5.2",
          reasoningEffort: "low",
        },
        {
          io: { input, output },
          services: {
            discoverTargetsWithOpenAI: async () => {
              const moduleName = "example.com/brrrsentry-smoke/panic-bug";
              const moduleRoot = targetDir;
              const filePath = path.join(moduleRoot, "panic.go");

              const candidate = {
                id: "e2e-fixture-1",
                language: "go",
                filePath,
                relativePath: "panic.go",
                moduleName,
                moduleRoot,
                symbol: "CrashOnSeed",
                signature: "func CrashOnSeed(data []byte) ([]byte, error)",
                kind: "function",
                score: 100,
                reasons: ["E2E fixture: panics on seed input"],
                packageName: "panicbug",
                importPath: moduleName,
                hasReceiver: false,
                isExported: true,
                acceptsBytes: true,
                acceptsString: false,
                acceptsContext: false,
                argCount: 1,
                fuzzInputArgIndex: 0,
                fuzzInputKind: "bytes",
              };

              return {
                moduleName,
                moduleRoot,
                candidates: [candidate],
                recommended: [candidate],
                notes: ["E2E: stub discovery result"],
              };
            },
            buildCampaignPlanWithOpenAI: async (config, target, fuzzMode, scopeMode) => {
              void config;
              void target;
              void fuzzMode;
              void scopeMode;
              return {
                title: "E2E panic-bug campaign",
                oracleStrategy: "Use gosentry crash output as the oracle.",
                grammarSummary: "Byte fuzzing only for this E2E case.",
                corpusIdeas: ["{}", "[]"],
                panicOnCandidates: [],
                reportExpectations: ["record real target bugs in FOUND_ISSUES.md"],
              };
            },
          },
          driver: {
            fuzzMode: "byte",
            scopeMode: "narrow",
            targetIndex: 0,
            afterResult: "run",
            runCores: "0",
            quitAfterRun: true,
            dismissAlerts: true,
          },
          hooks: {
            onAlert: (alert) => {
              alerts.push(alert);
            },
          },
        },
      );

      const bugAlert = alerts.find((alert) => alert.title === "Bug Alert");
      assert.ok(
        bugAlert,
        `expected Bug Alert, got: ${alerts.map((alert) => alert.title).join(", ")}`,
      );
      assert.equal(bugAlert.kind, "error");

      const campaignsRoot = path.join(targetDir, ".brrrsentry", "campaigns");
      const campaignDirs = (await fs.readdir(campaignsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.equal(campaignDirs.length, 1);

      const issuesPath = path.join(
        campaignsRoot,
        campaignDirs[0],
        "FOUND_ISSUES.md",
      );
      const issues = await fs.readFile(issuesPath, "utf8");
      assert.match(issues, /verdict: real_bug/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
