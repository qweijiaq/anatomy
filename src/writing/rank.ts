/**
 * Ordering the points, and collapsing the duplicates.
 *
 * The report is only worth reading if its top five are the five best, so the
 * order has to come from somewhere the model cannot flatter itself: the score
 * of the candidate the point was written from. Everything else here follows
 * from that:
 *
 * - a citation is matched to its candidate by path and line, because a point
 *   inherits the strength of the signal that produced it; a point whose only
 *   resemblance to a candidate is its topic inherits the best score among the
 *   candidates on its own evidence paths, and a point with no candidate there
 *   gets the minimum, so an orphan can never outrank a real signal;
 * - evidence beats confidence. A point with no verifiable citation sorts below
 *   every point that has one, whatever either of them scored, because that is
 *   the difference between a claim about this repository and a plausible essay
 *   about repositories in general;
 * - two points of the same kind citing the same file are one decision seen
 *   twice. The higher-ranked one survives, so the report does not spend two of
 *   its five slots on the same idea.
 *
 * Pure: it takes the points and the candidates, and returns a new array. It
 * touches neither input, and it never throws for a malformed point, because a
 * report that fails to rank is worse than one that ranks what it has.
 */

import type {
  Candidate,
  Evidence,
  LearningPoint,
  LearningPointKind,
  SignalKind,
} from '../contracts/types.js'

/**
 * Which signals tend to produce which kinds of point.
 *
 * Used only as the fallback when a point's evidence matches no candidate — a
 * judged point may cite lines the candidate's window merely covered, and the
 * better answer there is "the same signal kind" rather than "no score". The
 * fallback still looks only at candidates on the point's own evidence paths: a
 * topic resemblance to some unrelated file is not a signal about this claim.
 */
const KIND_AFFINITY: Record<LearningPointKind, readonly SignalKind[]> = {
  architecture: ['abstraction', 'custom-infra'],
  algorithm: ['complexity'],
  'data-model': ['abstraction'],
  'api-design': ['abstraction', 'custom-infra'],
  performance: ['complexity'],
  testing: ['test-spec'],
  tooling: ['custom-infra'],
  process: ['decision-trace', 'evolution'],
}

/** How a citation and a candidate path are compared: posix, no `./` prefix. */
function pathKey(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Arrays are objects at runtime and are not points; `synthesis.ts` agrees. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function evidenceOf(point: LearningPoint): Evidence[] {
  const evidence = (point as { theirs?: { evidence?: unknown } }).theirs?.evidence
  if (!Array.isArray(evidence)) return []
  return evidence.filter(isObject) as Evidence[]
}

/**
 * Whether the point carries a citation that could survive Task 10 at all.
 *
 * Not whether it *did* survive — `validatePoints` owns truth. This is the
 * cheaper question the ranking needs: is there a real line range behind it, or
 * only prose? The expensive answer is already reflected in the point's
 * confidence, which is why confidence is not consulted here.
 */
function isVerifiable(evidence: Evidence[]): boolean {
  return evidence.some((item) => {
    if (typeof item !== 'object' || item === null) return false
    const { path: citePath, startLine, endLine } = item
    return (
      typeof citePath === 'string' &&
      citePath !== '' &&
      Number.isInteger(startLine) &&
      Number.isInteger(endLine) &&
      startLine >= 1 &&
      endLine >= startLine
    )
  })
}

function scoreValue(candidate: Candidate): number {
  return typeof candidate.score === 'number' && Number.isFinite(candidate.score)
    ? candidate.score
    : 0
}

/** The candidate a citation points at, if any: same file, line inside the range. */
function citationScore(evidence: Evidence[], candidates: Candidate[]): number | null {
  let best: number | null = null
  for (const candidate of candidates) {
    const key = pathKey(candidate.path)
    if (key === '') continue
    const line = candidate.line
    if (!Number.isFinite(line)) continue
    const hit = evidence.some(
      (item) =>
        pathKey(item.path) === key &&
        Number.isInteger(item.startLine) &&
        Number.isInteger(item.endLine) &&
        line >= item.startLine &&
        line <= item.endLine,
    )
    if (!hit) continue
    const score = scoreValue(candidate)
    best = best === null ? score : Math.max(best, score)
  }
  return best
}

/**
 * The best score among candidates on the point's evidence paths, of an affine
 * kind. Never a candidate from a file the point does not cite: a point citing
 * `src/a.ts:100-110` cannot inherit 0.9 from `src/z.ts`.
 */
function affinityScore(point: LearningPoint, candidates: Candidate[]): number | null {
  const affinity = KIND_AFFINITY[point.kind] ?? []
  const cited = new Set(evidenceOf(point).map((item) => pathKey(item.path)))
  cited.delete('')
  if (cited.size === 0) return null
  let best: number | null = null
  for (const candidate of candidates) {
    if (!isObject(candidate) || !affinity.includes(candidate.kind)) continue
    if (!cited.has(pathKey(candidate.path))) continue
    const score = scoreValue(candidate)
    best = best === null ? score : Math.max(best, score)
  }
  return best
}

function minimumScore(candidates: Candidate[]): number {
  let minimum = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const score = scoreValue(candidates[index] as Candidate)
    minimum = index === 0 ? score : Math.min(minimum, score)
  }
  return minimum
}

function scoreOf(point: LearningPoint, candidates: Candidate[]): number {
  const evidence = evidenceOf(point)
  const cited = citationScore(evidence, candidates)
  if (cited !== null) return cited
  const affine = affinityScore(point, candidates)
  if (affine !== null) return affine
  return minimumScore(candidates)
}

/**
 * The merge keys of a point: one per file it cites, namespaced by kind.
 *
 * Two points share a decision when they share a kind and a file. Points with no
 * evidence have no keys and therefore never collapse into each other: without a
 * citation there is nothing to prove they are about the same thing.
 */
function mergeKeys(point: LearningPoint): string[] {
  const kind = typeof point.kind === 'string' ? point.kind : ''
  const seen = new Set<string>()
  for (const item of evidenceOf(point)) {
    const key = pathKey(item.path)
    if (key === '') continue
    seen.add(`${kind}\u0000${key}`)
  }
  return [...seen]
}

type Entry = { point: LearningPoint; score: number; verifiable: boolean; order: number }

function compare(a: Entry, b: Entry): number {
  if (a.verifiable !== b.verifiable) return a.verifiable ? -1 : 1
  if (a.score !== b.score) return b.score - a.score
  // Deterministic tie-break: the same input always produces the same report,
  // whatever order the points happened to arrive in.
  const left = typeof a.point.id === 'string' ? a.point.id : ''
  const right = typeof b.point.id === 'string' ? b.point.id : ''
  if (left !== right) return left < right ? -1 : 1
  return a.order - b.order
}

/**
 * The points in report order, deduplicated.
 *
 * Returns the same objects the caller passed, so a later stage can still match
 * a point to its judgement; only the array is new.
 */
export function rankPoints(points: LearningPoint[], candidates: Candidate[]): LearningPoint[] {
  const list = (Array.isArray(points) ? points : []).filter(
    (point): point is LearningPoint => isObject(point),
  )
  const signals = (Array.isArray(candidates) ? candidates : []).filter(
    (candidate): candidate is Candidate => isObject(candidate),
  )

  const ranked = list
    .map((point, order): Entry => {
      const evidence = evidenceOf(point)
      return {
        point,
        order,
        verifiable: isVerifiable(evidence),
        score: scoreOf(point, signals),
      }
    })
    .sort(compare)

  const taken = new Set<string>()
  const kept: LearningPoint[] = []
  for (const entry of ranked) {
    const keys = mergeKeys(entry.point)
    if (keys.some((key) => taken.has(key))) continue
    for (const key of keys) taken.add(key)
    kept.push(entry.point)
  }
  return kept
}
