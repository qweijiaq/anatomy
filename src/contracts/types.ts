/**
 * Shared types for anatomy. Types and constants only — no runtime behaviour.
 * Every module imports from here; nothing here imports from the project.
 */

// --- analysis scope -------------------------------------------------------

export type ScopeExclusionReason =
  | 'gitignore'
  /** Version-control bookkeeping (`.git`): never analysed, and never the
   * project's own code either, so it must not be reported as vendored. */
  | 'vcs'
  /** A source file in a language this version cannot read (Rust, Go, Java …).
   * Named separately from the size reasons because it is a capability gap the
   * report has to state, not a judgement about the file. */
  | 'unsupported-language'
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

/**
 * A line-addressed view of a file.
 *
 * When `truncated` is false, `text` is exactly lines `startLine..endLine`.
 *
 * When `truncated` is true, `text` is the head lines, then one `...` elision
 * line, then the tail lines. `omitted` says which real lines the elision
 * replaced: the head text is `startLine..omitted.startLine-1` and the tail
 * text is `omitted.endLine+1..endLine`. Consumers must address lines through
 * `omitted`, never by counting `text` lines: `...` is legal source in some
 * languages, so the marker is not a reliable string signal.
 */
export type Slice = {
  path: string
  startLine: number
  endLine: number
  text: string
  truncated: boolean
  omitted: { startLine: number; endLine: number } | null
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
  /** A function named after a published algorithm: a design choice in itself. */
  | 'algorithm'
  /**
   * A call to an API that exists because a naive version is wrong: constant-time
   * comparison, a signed payload, a permission bit, a trusted-proxy header. The
   * shape is fixed, so recognising it needs no judgement about intent.
   */
  | 'security'
  /**
   * A database constraint or transaction boundary. Integrity is declared where it
   * can be enforced rather than in every caller, which is a decision with a cost.
   */
  | 'data-integrity'
  /**
   * A deliberate bound on a failure: a timeout, an error carrying a status, a
   * retry ceiling. The alternative — unbounded waiting — is the bug being avoided.
   */
  | 'resilience'
  /**
   * A local trick in a short function: testing a capability instead of a type,
   * folding two loop conditions into one guard, pre-binding arguments, generating
   * from a table. Small libraries are read *for* these, and they are invisible to
   * every rule that keys on names or length.
   */
  | 'idiom'

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
  /**
   * `complete` only once every artifact is on disk. A run that opened and then
   * failed stays `failed`, so a directory full of manifest-but-no-artifacts can
   * never be mistaken for something worth reporting.
   */
  status: 'complete' | 'failed'
  /** When the last artifact landed. Absent for a `failed` run. */
  completedAt?: string
  /**
   * The directory the run actually analysed. A release archive wraps the
   * project in `<owner>-<repo>-<sha>/`, and analysing the wrapper would make
   * every reported path one level deeper than the reader expects.
   */
  treeRoot?: string
}

export type ReportInput = {
  /** What the reader asked about: the URL or path handed to `analyze`. */
  source: string
  problem: string
  topFive: string[]
  points: LearningPoint[]
  validation: ValidationResult
  profile: Profile
  scope: Scope
  skipped: string[]
  /**
   * What the kernel saw, for the appendix.
   *
   * Optional because a report can be re-rendered from a run directory written
   * before these were stored: the section is dropped rather than the run refused.
   */
  candidates?: Candidate[]
  structure?: StructureIndex
}

// --- defaults (spec §5, §7.2, R9) ----------------------------------------

export const DEFAULT_LIMITS: ScopeLimits = {
  maxBytes: 200 * 1024 * 1024,
  maxFiles: 200_000,
  maxLines: 500_000,
}

/**
 * Default per-request token budget for a candidate batch.
 *
 * Sized to fit the largest context `tokenx` knows (128k) with 28k of headroom
 * for the answer and the fixed prompt around the batch, and to fit every
 * smaller window once `clampBudget` has narrowed it. A default larger than any
 * real context would answer "fits" for a batch no model can accept.
 */
export const DEFAULT_BUDGET_TOKENS = 100_000
export const DEFAULT_TOP_K = 30
export const DEFAULT_SLICE_MAX_LINES = 200
