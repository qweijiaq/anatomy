/**
 * The report as data: one normaliser, two writers.
 *
 * `buildReport` takes whatever the pipeline handed over and produces the single
 * document both `report.md` and `report.json` are rendered from. It is
 * deliberately suspicious of its input — the points came out of a language
 * model and back off disk — so every field is shape-checked and defaulted here
 * instead of inside a formatter, and no renderer ever throws because one point
 * was malformed.
 *
 * The one rule enforced at this boundary is the product's core promise: a point
 * without a followable citation is not a point the report may show. Such a point
 * is not silently deleted; it moves to `notRendered` with a reason, so the
 * markdown tail can say how many claims were withheld and the JSON consumer sees
 * the same tally.
 *
 * Nothing here recomputes a statistic. `trust` is a copy of
 * `validation.stats`, and the scope numbers are copies of `scope.totals`: the
 * file that measured them is the only place allowed to change them.
 */

import type { ReportInput } from '../contracts/types.js'

// --- document shape -------------------------------------------------------

export type ReportEvidence = {
  id: string
  path: string
  startLine: number
  endLine: number
  /** Verbatim source text. Never translated, trimmed or re-indented. */
  snippet: string
}

export type ReportPoint = {
  id: string
  title: string
  kind: string
  confidence: string
  problem: { constraint: string; stakes: string }
  alternatives: Array<{ approach: string; cost: string }>
  theirs: { summary: string; evidence: ReportEvidence[] }
  mechanism: string
  tradeoffs: Array<{ cost: string; whenItHurts: string }>
  unknowns: string[]
  recipe: { prereqs: string[]; minimalForm: string; avoidWhen: string[] } | null
}

export type ReportTrust = {
  evidenceRate: number
  droppedEvidence: number
  avgEvidence: number
}

export type ReportAnalysis = {
  root: string
  totals: { files: number; bytes: number; lines: number }
  excluded: Array<{ reason: string; count: number }>
  /** `scope.byLanguage`, sorted for a stable document. */
  languages: Array<{ language: string; files: number }>
}

export type ReportJudgement = { pointId: string; reason: string }

export type ReportNotRendered = { pointId: string; reason: string }

export type ReportDocument = {
  repo: string
  problem: string
  topFive: string[]
  trust: ReportTrust
  analysis: ReportAnalysis
  points: ReportPoint[]
  /** Points withheld from the page because no citation could be followed. */
  notRendered: ReportNotRendered[]
  /** What was skipped, as the pipeline declared it (budget cuts, unread input). */
  skipped: string[]
  /** `profile.notes`: unsupported languages, tooling gaps. */
  notes: string[]
  validation: { downgraded: ReportJudgement[]; dropped: ReportJudgement[] }
}

/** Why a point could not be shown. One reason, and it is our own text. */
export const NOT_RENDERED_REASON = '没有可核对的证据（path:startLine-endLine 或原文片段缺失）'

// --- defensive readers ----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function integers(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function judgementList(value: unknown): ReportJudgement[] {
  if (!Array.isArray(value)) return []
  const out: ReportJudgement[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const pointId = text(item['pointId'])
    const reason = text(item['reason'])
    if (pointId === '') continue
    out.push({ pointId, reason })
  }
  return out
}

// --- normalisers ----------------------------------------------------------

/**
 * One citable piece of evidence, or `null` when a reader could not follow it.
 *
 * The check is the one the reader performs: a path that can be opened, a line
 * range that can be navigated, and text that can be compared. Anything else is
 * not evidence, however plausible it reads.
 */
export function normalizeEvidence(value: unknown, index: number): ReportEvidence | null {
  const raw = record(value)
  const path = text(raw['path'])
  const startLine = integers(raw['startLine'])
  const endLine = integers(raw['endLine'])
  const snippet = text(raw['snippet'])

  if (path === '') return null
  if (startLine === null || endLine === null) return null
  if (startLine < 1 || endLine < startLine) return null
  if (snippet.trim() === '') return null

  const id = text(raw['id'])
  return {
    id: id === '' ? `evidence-${index + 1}` : id,
    path,
    startLine,
    endLine,
    snippet,
  }
}

function normalizeRecipe(value: unknown): ReportPoint['recipe'] {
  if (!isRecord(value)) return null
  return {
    prereqs: stringList(value['prereqs']),
    minimalForm: text(value['minimalForm']),
    avoidWhen: stringList(value['avoidWhen']),
  }
}

function normalizePoint(value: unknown, index: number): ReportPoint | null {
  if (!isRecord(value)) return null

  const theirs = record(value['theirs'])
  const evidenceRaw = Array.isArray(theirs['evidence']) ? theirs['evidence'] : []
  const evidence: ReportEvidence[] = []
  evidenceRaw.forEach((item, itemIndex) => {
    const normalized = normalizeEvidence(item, itemIndex)
    if (normalized !== null) evidence.push(normalized)
  })

  const problem = record(value['problem'])
  const alternatives = Array.isArray(value['alternatives']) ? value['alternatives'] : []
  const tradeoffs = Array.isArray(value['tradeoffs']) ? value['tradeoffs'] : []

  const id = text(value['id'])
  return {
    id: id === '' ? `point-${index + 1}` : id,
    title: text(value['title']),
    kind: text(value['kind']),
    confidence: text(value['confidence']),
    problem: { constraint: text(problem['constraint']), stakes: text(problem['stakes']) },
    alternatives: alternatives
      .filter(isRecord)
      .map((item) => ({ approach: text(item['approach']), cost: text(item['cost']) })),
    theirs: { summary: text(theirs['summary']), evidence },
    mechanism: text(value['mechanism']),
    tradeoffs: tradeoffs
      .filter(isRecord)
      .map((item) => ({ cost: text(item['cost']), whenItHurts: text(item['whenItHurts']) })),
    unknowns: stringList(value['unknowns']),
    recipe: normalizeRecipe(value['recipe']),
  }
}

/**
 * The repository's display name: the last path segment of the analysed root.
 *
 * `scope.root` is absolute, so the report's title is the directory the reader
 * would type, not the whole path — the full path belongs in the 口径 block,
 * where it is evidence rather than decoration.
 */
export function repoName(root: unknown): string {
  if (typeof root !== 'string') return ''
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter((part) => part !== '')
  return parts.length === 0 ? '' : (parts[parts.length - 1] as string)
}

function languageList(value: unknown): ReportAnalysis['languages'] {
  if (!isRecord(value)) return []
  const entries: Array<{ language: string; files: number }> = []
  for (const [language, files] of Object.entries(value)) {
    if (language === '' || typeof files !== 'number' || !Number.isFinite(files)) continue
    entries.push({ language, files })
  }
  return entries.sort((a, b) =>
    a.files === b.files
      ? a.language < b.language
        ? -1
        : a.language > b.language
          ? 1
          : 0
      : b.files - a.files,
  )
}

function exclusionList(value: unknown): ReportAnalysis['excluded'] {
  if (!Array.isArray(value)) return []
  const out: ReportAnalysis['excluded'] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const reason = text(item['reason'])
    if (reason === '') continue
    out.push({ reason, count: count(item['count']) })
  }
  return out
}

// --- document -------------------------------------------------------------

/** Normalise the report input once, for both writers. Pure and total. */
export function buildReport(input: ReportInput): ReportDocument {
  const source = record(input)
  const profile = record(source['profile'])
  const scope = record(source['scope'])
  const validation = record(source['validation'])
  const stats = record(validation['stats'])
  const totals = record(scope['totals'])

  const pointsRaw = Array.isArray(source['points']) ? source['points'] : []
  const points: ReportPoint[] = []
  const notRendered: ReportNotRendered[] = []
  pointsRaw.forEach((item, index) => {
    const point = normalizePoint(item, index)
    if (point === null) return
    if (point.theirs.evidence.length === 0) {
      notRendered.push({ pointId: point.id, reason: NOT_RENDERED_REASON })
      return
    }
    points.push(point)
  })

  return {
    repo: repoName(scope['root']),
    problem: text(source['problem']),
    topFive: stringList(source['topFive']),
    trust: {
      evidenceRate: count(stats['evidenceRate']),
      droppedEvidence: count(stats['droppedEvidence']),
      avgEvidence: count(stats['avgEvidence']),
    },
    analysis: {
      root: text(scope['root']),
      totals: {
        files: count(totals['files']),
        bytes: count(totals['bytes']),
        lines: count(totals['lines']),
      },
      excluded: exclusionList(scope['excluded']),
      languages: languageList(scope['byLanguage']),
    },
    points,
    notRendered,
    skipped: stringList(source['skipped']),
    notes: stringList(profile['notes']),
    validation: {
      downgraded: judgementList(validation['downgraded']),
      dropped: judgementList(validation['dropped']),
    },
  }
}

/** The report document as stable, pretty JSON. Parses back to `buildReport`. */
export function renderJson(input: ReportInput): string {
  return `${JSON.stringify(buildReport(input), null, 2)}\n`
}
