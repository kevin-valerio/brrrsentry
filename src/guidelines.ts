export interface GuidelineSection {
  title: string;
  bullets: string[];
}

// These guidelines are extracted from the local `prompts/*.md` source material.
// They are tracked in code so brrrsentry keeps the constraints even when
// `prompts/` is kept local-only (gitignored).
export const FUZZING_GUIDELINES: GuidelineSection[] = [
  {
    title: "Tooling (gosentry required)",
    bullets: [
      "Use gosentry and its features for the campaign (do not propose other fuzzers).",
      "Do not guess gosentry flags. Base choices (panic-on, grammar mode, leak/race detectors) on the gosentry README.",
    ],
  },
  {
    title: "Target pairing (Go vs Go / Go vs X)",
    bullets: [
      "Harness must be Go vs Go or Go vs X (X can be Rust or C/C++).",
      'It is acceptable to fuzz "itself vs itself" as long as the oracle and checks are meaningful.',
      "Decide if race and leak detection is needed for this target based on expected bug class and runtime cost.",
    ],
  },
  {
    title: "In-process requirement (coverage-guided)",
    bullets: [
      "At least one target must run in-process and provide coverage guidance.",
      "The second target may be in-process (preferred) or a CLI oracle.",
      "Both targets cannot be CLI-only.",
      "It is OK to fuzz many targets at once as long as one is in-process and coverage-guided.",
    ],
  },
  {
    title: "Bug quality (reproducibility and realism)",
    bullets: [
      "Harness must be reproducible from an attacker or bug-report perspective.",
      "Focus on security-impacting bugs and attacker-relevant paths.",
      "Avoid unrealistic deep internal helpers that cannot be reached through real usage.",
      "Avoid targets that require secret/admin keys (example: sequencer key compromise) or admin-only flows.",
    ],
  },
  {
    title: "Use tests as harness guidance",
    bullets: [
      "Use end-to-end tests, integration tests, or other high-level tests to understand realistic workflows to fuzz.",
      "Use tests/specs to decide what counts as accepted vs rejected input and what outputs must match.",
    ],
  },
  {
    title: "Grammar fuzzing (Nautilus)",
    bullets: [
      "If using grammar fuzzing, the grammar must fit the target input language or format.",
      "Grammar mode works best with a single fuzz input argument of []byte or string.",
      "Grammar mode still produces bytes or strings. Convert to domain values inside the harness.",
      "Use the gosentry grammar tutorial and examples to author the Nautilus JSON grammar.",
    ],
  },
  {
    title: "Error handling and panic-on",
    bullets: [
      "Enable panic on critical error paths (for example via --panic-on) when applicable.",
      "Identify relevant error or logging functions and configure panic-on accordingly.",
      "If the target uses leveled logging (example: LvlCrit/LvlError/...), panic on critical + error levels.",
    ],
  },
  {
    title: "Initial corpus",
    bullets: [
      "Initial corpus must be diversified, not many similar entries.",
      "Seed from project specs and tests when possible (one feature or case per seed).",
      "Use corpus and grammar together: grammar can be derived from corpus or the opposite.",
    ],
  },
  {
    title: "Campaign scripts and reporting",
    bullets: [
      "Generate a fuzz.bash script runnable like: CORES=0,1,2,3 ./fuzz.bash",
      "Most bugs appear early. Treat non-harness crashes as real bugs until proven otherwise.",
      "Avoid admin-only or unrealistic targets.",
      "Record real target issues in FOUND_ISSUES.md and campaign details in FUZZ.md.",
    ],
  },
  {
    title: "Differential fuzzing signals",
    bullets: [
      "Bugs can include: crash, panic, hang, timeout, resource blowup, or state divergence.",
      "Also treat mismatched return codes, acceptance decisions, hashes or roots as bugs.",
      "Also treat proof disagreements (or verification disagreements) as bugs when applicable.",
      "For differential fuzzing, name the source-of-truth oracle and which target is the weakest to test.",
      "Prefer strong, app-specific invariants when a reference implementation exists.",
    ],
  },
  {
    title: "Research",
    bullets: ["If you need specs or reference implementations, internet research is allowed."],
  },
];

export function formatGuidelinesForPrompt(): string {
  const lines: string[] = [];

  lines.push("Guidelines (must follow):");
  for (const section of FUZZING_GUIDELINES) {
    for (const bullet of section.bullets) {
      lines.push(`- [${section.title}] ${bullet}`);
    }
  }

  return lines.join("\n");
}

export function formatGuidelinesForFuzzDoc(): string {
  const lines: string[] = [];

  lines.push("Guidelines");
  lines.push("");
  for (const section of FUZZING_GUIDELINES) {
    lines.push(section.title);
    lines.push("");
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
