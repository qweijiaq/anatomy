/**
 * Shared types for anatomy. Types and constants only — no runtime behaviour.
 * Every module imports from here; nothing here imports from the project.
 */

// --- analysis scope -------------------------------------------------------

export type ScopeExclusionReason =
  | 'gitignore'
  | 'vendored'
  | 'generated'
  | 'minified'
  | 'lockfile'
  | 'binary'
  | 'large-fixture'

export type ScopeFile = {
  path: string
  bytes: number
  lines: number
  language: string | null
}

export type Scope = {
  root: string
  files: ScopeFile[]
  excluded: Array<{ reason: ScopeExclusionReason; count: number }>
  totals: { files: number; bytes: number; lines: number }
  byLanguage: Record<string, number>
}

export type ScopeLimits = {
  maxBytes: number
  maxFiles: number
  maxLines: number
}

export type ScopeOptions = {
  subpath?: string
  limits?: ScopeLimits
  extraIgnore?: string[]
}

// --- file text ------------------------------------------------------------

export type CanonicalFile = {
  path: string
  text: string
  lineCount: number
  encoding: 'utf8' | 'latin1'
  hadBom: boolean
}

export type Slice = {
  path: string
  startLine: number
  endLine: number
  text: string
  truncated: boolean
}

// --- repository shape -----------------------------------------------------

export type ImportEdge = {
  from: string
  specifier: string
  resolved: string | null
}

export type ModuleNode = {
  path: string
  imports: ImportEdge[]
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'method'

export type SymbolRef = {
  name: string
  kind: SymbolKind
  path: string
  line: number
}

export type StructureIndex = {
  modules: ModuleNode[]
  symbols: SymbolRef[]
  unresolved: number
  notes: string[]
}

export type Profile = {
  languages: Record<string, number>
  manifests: string[]
  entryPoints: string[]
  hasTests: boolean
  hasCi: boolean
  hasDocs: boolean
  notes: string[]
}

// --- candidates -----------------------------------------------------------

export type SignalKind =
  | 'custom-infra'
  | 'abstraction'
  | 'decision-trace'
  | 'evolution'
  | 'complexity'
  | 'test-spec'

export type Candidate = {
  id: string
  path: string
  line: number
  kind: SignalKind
  score: number
  matched: string[]
}

// --- learning points ------------------------------------------------------

export type Evidence = {
  id: string
  path: string
  startLine: number
  endLine: number
  snippet: string
}

export type LearningPointKind =
  | 'architecture'
  | 'algorithm'
  | 'data-model'
  | 'api-design'
  | 'performance'
  | 'testing'
  | 'tooling'
  | 'process'

export type Confidence = 'high' | 'medium' | 'low'

export type Recipe = {
  prereqs: string[]
  minimalForm: string
  avoidWhen: string[]
}

export type LearningPoint = {
  id: string
  title: string
  kind: LearningPointKind
  problem: { constraint: string; stakes: string }
  alternatives: Array<{ approach: string; cost: string }>
  theirs: { summary: string; evidence: Evidence[] }
  mechanism: string
  tradeoffs: Array<{ cost: string; whenItHurts: string }>
  confidence: Confidence
  unknowns: string[]
  recipe: Recipe | null
}

export type Judgement = {
  points: LearningPoint[]
  usage: { in: number; out: number }
}

export type ValidationResult = {
  kept: LearningPoint[]
  downgraded: Array<{ pointId: string; reason: string }>
  dropped: Array<{ pointId: string; reason: string }>
  stats: {
    evidenceRate: number
    droppedEvidence: number
    avgEvidence: number
  }
}

// --- runs and reporting ---------------------------------------------------

export type RunManifest = {
  runId: string
  source: string
  ref: string
  sha: string
  subpath: string
  engineVersion: string
  startedAt: string
}

export type ReportInput = {
  problem: string
  topFive: string[]
  points: LearningPoint[]
  validation: ValidationResult
  profile: Profile
  scope: Scope
  skipped: string[]
}

// --- defaults (spec §5, §7.2, R9) ----------------------------------------

export const DEFAULT_LIMITS: ScopeLimits = {
  maxBytes: 200 * 1024 * 1024,
  maxFiles: 200_000,
  maxLines: 500_000,
}

export const DEFAULT_BUDGET_TOKENS = 500_000
export const DEFAULT_TOP_K = 30
export const DEFAULT_SLICE_MAX_LINES = 200
