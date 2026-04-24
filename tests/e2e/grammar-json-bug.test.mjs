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

  sink.isTTY = true;
  sink.columns = 120;
  sink.rows = 40;

  return sink;
}

async function makeTempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test(
  "e2e: grammar-json-bug -> grammar/narrow -> run -> Bug Alert",
  { timeout: 20 * 60_000 },
  async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for E2E tests");
    }

    const repoRoot = process.cwd();
    const fixtureRoot = path.resolve(repoRoot, "tests", "smoke", "grammar-json-bug");
    const tempRoot = await makeTempDir("brrrsentry-grammar-e2e-");
    const targetDir = path.join(tempRoot, "target");
    const generatedGrammar = `${JSON.stringify([["Json", "\"abba\""]], null, 2)}\n`;
    let grammarGenerationCalled = false;

    try {
      await fs.cp(fixtureRoot, targetDir, { recursive: true });

      const input = new PassThrough();
      input.isTTY = true;
      input.setRawMode = () => {};
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
              const moduleName = "example.com/brrrsentry-smoke/grammar-json-bug";
              const moduleRoot = targetDir;
              const filePath = path.join(moduleRoot, "parse.go");

              const candidate = {
                id: "e2e-grammar-fixture-1",
                language: "go",
                filePath,
                relativePath: "parse.go",
                moduleName,
                moduleRoot,
                symbol: "Parse",
                signature: "func Parse(data []byte) (string, error)",
                kind: "function",
                score: 100,
                reasons: ["E2E fixture: JSON string parser with a trivial panic"],
                packageName: "grammarjson",
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
            buildCampaignPlanWithOpenAI: async () => {
              return {
                title: "E2E grammar-json-bug campaign",
                oracleStrategy: "Use gosentry crash output as the oracle.",
                grammarSummary: "Generate JSON strings for the Parse entrypoint.",
                corpusIdeas: ["\"a\"", "\"b\"", "\"abba\""],
                panicOnCandidates: [],
                reportExpectations: ["record real target bugs in FOUND_ISSUES.md"],
              };
            },
            generateNautilusGrammarWithOpenAI: async (_config, input) => {
              grammarGenerationCalled = true;
              assert.equal(input.plan.fuzzMode, "grammar");
              assert.match(input.harnessSource, /targetpkg\.Parse/);

              return {
                grammarJson: generatedGrammar,
                notes: ["E2E: deterministic JSON string grammar"],
              };
            },
          },
          driver: {
            fuzzMode: "grammar",
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

      assert.equal(grammarGenerationCalled, true);

      const bugAlert = alerts.find((alert) => alert.title === "Bug Alert");
      assert.ok(
        bugAlert,
        `expected Bug Alert, got: ${alerts.map((alert) => alert.title).join(", ")}`,
      );
      assert.equal(bugAlert.kind, "error");
      assert.match(bugAlert.body, /Fuzzing found a real bug/);

      const campaignsRoot = path.join(targetDir, ".brrrsentry", "campaigns");
      const campaignDirs = (await fs.readdir(campaignsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.equal(campaignDirs.length, 1);

      const campaignRoot = path.join(campaignsRoot, campaignDirs[0]);
      const grammar = await fs.readFile(
        path.join(campaignRoot, "grammar", "grammar.json"),
        "utf8",
      );
      assert.equal(grammar, generatedGrammar);

      const fuzzScript = await fs.readFile(path.join(campaignRoot, "fuzz.bash"), "utf8");
      assert.match(fuzzScript, /--use-grammar/);
      assert.match(fuzzScript, /--grammar "\$CAMPAIGN_ROOT\/grammar\/grammar\.json"/);

      const issues = await fs.readFile(path.join(campaignRoot, "FOUND_ISSUES.md"), "utf8");
      assert.match(issues, /verdict: real_bug/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
