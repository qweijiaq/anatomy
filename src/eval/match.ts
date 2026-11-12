/**
 * Scoring a run against hand-written gold points.
 *
 * A gold point is a claim about a place in a repository: "the interesting
 * decision is in `src/a.ts`, around lines 10-12, and here is why". A produced
 * point is judged by the only thing that is mechanically checkable — whether it
 * lands on the same file and on a line range that really overlaps — and never by
 * how similar the prose is. Two runs that describe the same region in different
 * words score the same, because the score is about finding the region.
 *
 * Pure and total on purpose: the input is a JSON file written by hand, so a
 * missing field is expected rather than exceptional, and a scorer that throws on
 * one bad entry cannot score the rest.
 */

export type GoldPoint = {
  path: string
  startLine: number
  endLine: number
  why: string
}

export type GoldFile = {
  repo: string
  ref: string
  sha: string
  points: GoldPoint[]
}

export type MatchResult = {
  recall: number
  /** The `why` of every gold point that was hit, in gold order. */
  matched: string[]
  /** Indices into `gold` of the points that were not hit. */
  missed: number[]
}

/** A produced point: the part of a learning point a scorer may look at. */
type ProducedPoint = { path: string; startLine: number; endLine: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A file line number: whole, positive, finite. */
function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isProducedPoint(value: unknown): value is ProducedPoint {
  return (
    isRecord(value) &&
    typeof value['path'] === 'string' &&
    value['path'] !== '' &&
    isLine(value['startLine']) &&
    isLine(value['endLine'])
  )
}

function isGoldPoint(value: unknown): value is GoldPoint {
  if (!isProducedPoint(value)) return false
  const why = (value as Record<string, unknown>)['why']
  return typeof why === 'string' && value.startLine <= value.endLine
}

/** Same file and intersecting ranges: the one definition of a hit. */
function hits(produced: ProducedPoint, gold: GoldPoint): boolean {
  return (
    produced.path === gold.path &&
    produced.startLine <= gold.endLine &&
    gold.startLine <= produced.endLine
  )
}

/**
 * Recall of `produced` against `gold`.
 *
 * Each gold point is asked once, so a run that reports the same region three
 * times gets one hit, not three. A malformed gold entry cannot be hit: it is
 * counted as missed, which keeps the denominator `gold.length` and keeps the
 * index meaning the same thing as the file it came from.
 */
export function matchGold(
  produced: ReadonlyArray<{ path: string; startLine: number; endLine: number }>,
  gold: ReadonlyArray<GoldPoint>,
): MatchResult {
  const usable: ProducedPoint[] = []
  for (const point of produced) if (isProducedPoint(point)) usable.push(point)

  const matched: string[] = []
  const missed: number[] = []

  for (let index = 0; index < gold.length; index += 1) {
    const point: unknown = gold[index]
    if (!isGoldPoint(point) || !usable.some((candidate) => hits(candidate, point))) {
      missed.push(index)
      continue
    }
    matched.push(point.why)
  }

  return {
    recall: gold.length === 0 ? 0 : matched.length / gold.length,
    matched,
    missed,
  }
}

/**
 * A parsed gold file, or `null` when the JSON is not one.
 *
 * Validation is all-or-nothing: a gold file is a test fixture, and a fixture
 * with one broken point would silently lower every score computed from it.
 * Unknown keys are dropped rather than preserved, so the returned value is
 * exactly the shape the scorer reads.
 */
export function readGold(value: unknown): GoldFile | null {
  if (!isRecord(value)) return null

  const repo = value['repo']
  const ref = value['ref']
  const sha = value['sha']
  if (typeof repo !== 'string' || typeof ref !== 'string' || typeof sha !== 'string') return null

  const raw = value['points']
  if (!Array.isArray(raw)) return null

  const points: GoldPoint[] = []
  for (const entry of raw) {
    if (!isGoldPoint(entry)) return null
    points.push({
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      why: entry.why,
    })
  }

  return { repo, ref, sha, points }
}
