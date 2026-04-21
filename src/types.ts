export type FuzzMode = "byte" | "struct-aware" | "grammar";
export type ScopeMode = "narrow" | "end-to-end" | "differential";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type TargetLanguage = string;

export interface AppConfig {
  repoRoot: string;
  targetDir: string;
  gosentryPath: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface CandidateTarget {
  id: string;
  language: TargetLanguage;
  filePath: string;
  relativePath: string;
  symbol: string;
  signature: string;
  kind: string;
  score: number;
  reasons: string[];
  packageName?: string;
  importPath?: string;
  hasReceiver?: boolean;
  isExported?: boolean;
  acceptsBytes?: boolean;
  acceptsString?: boolean;
  acceptsContext?: boolean;
  argCount?: number;
  contextArgIndex?: number;
  fuzzInputArgIndex?: number;
  fuzzInputKind?: "bytes" | "string";
}

export interface RepositoryDiscoveryFile {
  relativePath: string;
  score: number;
  reasons: string[];
}

export interface RepositoryDiscoveryPreview extends RepositoryDiscoveryFile {
  content: string;
}

export interface RepositoryDiscoveryContext {
  moduleName?: string;
  moduleRoot?: string;
  totalFiles: number;
  inventory: RepositoryDiscoveryFile[];
  previews: RepositoryDiscoveryPreview[];
  notes: string[];
}

export interface DiscoveryResult {
  moduleName?: string;
  moduleRoot?: string;
  candidates: CandidateTarget[];
  recommended: CandidateTarget[];
  notes: string[];
}

export interface CampaignPlan {
  slug: string;
  title: string;
  fuzzMode: FuzzMode;
  scopeMode: ScopeMode;
  target: CandidateTarget;
  oracleStrategy: string;
  harnessStrategy: string;
  grammarSummary: string;
  corpusIdeas: string[];
  panicOnCandidates: string[];
  reportExpectations: string[];
}

export interface GeneratedCampaign {
  rootDir: string;
  fuzzDocPath: string;
  issuesPath: string;
  fuzzScriptPath: string;
  harnessPath: string;
}
