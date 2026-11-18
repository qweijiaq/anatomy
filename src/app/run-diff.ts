/**
 * Two source analyses of the same repository, compared as facts.
 *
 * A report is prose, and diffing prose would produce a second opinion that drifts
 * from both runs. What can be compared without judgement is the arithmetic: how
 * many points each run kept, what share of them carried evidence, how many
 * candidates were collected, how large the tree was, and which point titles
 * appeared or disappeared. Those numbers come straight out of the artifacts.
 *
 * ## The one way this can mislead
 *
 * Two runs of different repositories, or two runs of different commits, are not a
 * before/after of one thing. The diff is still computed — refusing would hide how
 * far apart they are — but it says so before the numbers, and it says when the two
 * runs share a commit rather than guessing from dates.
 */

import type {
  Candidate,
  LearningPoint,
  RunManifest,
  Scope,
  ValidationResult,
} from '../contracts/types.js'

/** One run, reduced to the fields a comparison can honestly use. */
export type RunSide = {
  runId: string
  source: string
  startedAt: string
  sha: string
  lang: 'zh' | 'en' | ''
  points: number
  evidenceRate: number | null
  candidates: number
  files: number
  lines: number
  bytes: number
  titles: string[]
}

/** A number that exists in both runs. `percent` is a ratio, not a percentage. */
export type RunCounter = {
  label: string
  before: number
  after: number
  format: 'count' | 'percent'
}

export type RunDiff = {
  before: RunSide
  after: RunSide
  /** Both runs name the same repository. */
  sameSource: boolean
  /** Both runs read the same commit. */
  sameTree: boolean
  /** False when the numbers are not a like-for-like comparison. */
  comparable: boolean
  /** Why not, in the reader's words. Empty when comparable. */
  warnings: string[]
  counters: RunCounter[]
  addedTitles: string[]
  removedTitles: string[]
}

export type RunArtifacts = {
  manifest: RunManifest
  points: LearningPoint[]
  validation: ValidationResult | null
  scope: Scope
  candidates: Candidate[]
}

/** Reduces a run's stored artifacts to the fields the comparison prints. */
export function summarizeRun(runId: string, artifacts: RunArtifacts): RunSide {
  const { manifest, points, validation, scope, candidates } = artifacts
  const rate = validation?.stats.evidenceRate
  return {
    runId,
    source: manifest.source,
    startedAt: manifest.startedAt,
    sha: manifest.sha,
    lang: manifest.lang ?? '',
    points: points.length,
    evidenceRate: typeof rate === 'number' && Number.isFinite(rate) ? rate : null,
    candidates: candidates.length,
    files: scope.totals.files,
    lines: scope.totals.lines,
    bytes: scope.totals.bytes,
    titles: points.map((point) => point.title),
  }
}

/** Title order is not a fact about the repository; compare as sets. */
function titleChange(before: readonly string[], after: readonly string[]): {
  added: string[]
  removed: string[]
} {
  const previous = new Set(before)
  const next = new Set(after)
  return {
    added: after.filter((title) => !previous.has(title)),
    removed: before.filter((title) => !next.has(title)),
  }
}

export function diffRuns(before: RunSide, after: RunSide): RunDiff {
  const warnings: string[] = []
  const normalize = (source: string): string => source.replace(/\/+$/, '').replace(/\.git$/, '')
  const sameSource = before.source !== '' && normalize(before.source) === normalize(after.source)
  const sameTree = before.sha !== '' && before.sha === after.sha

  if (!sameSource) {
    warnings.push(
      `两次分析的不是同一个仓库：前一份是 ${before.source || '(未知)'}，后一份是 ${after.source || '(未知)'}。下面的差异不是版本变化。`,
    )
  } else if (!sameTree) {
    warnings.push('两次分析的是同一个仓库的不同提交，差异里既有代码变化，也可能有拉取时点的变化。')
  }

  const titles = titleChange(before.titles, after.titles)
  const rate = (value: number | null): number => (value === null ? -1 : value)

  return {
    before,
    after,
    sameSource,
    sameTree,
    comparable: warnings.length === 0,
    warnings,
    counters: [
      { label: '学习点', before: before.points, after: after.points, format: 'count' },
      { label: '已取证占比', before: rate(before.evidenceRate), after: rate(after.evidenceRate), format: 'percent' },
      { label: '候选点', before: before.candidates, after: after.candidates, format: 'count' },
      { label: '文件', before: before.files, after: after.files, format: 'count' },
      { label: '行数', before: before.lines, after: after.lines, format: 'count' },
    ],
    addedTitles: titles.added,
    removedTitles: titles.removed,
  }
}

/**
 * True when nothing the view would print has changed.
 *
 * A different commit alone is not "empty": the reader comparing two runs wants to
 * know they are looking at the same tree, even when every number happens to match.
 */
export function isEmptyRunDiff(diff: RunDiff): boolean {
  return (
    diff.comparable &&
    diff.sameTree &&
    diff.counters.every((row) => row.before === row.after) &&
    diff.addedTitles.length === 0 &&
    diff.removedTitles.length === 0
  )
}
