/**
 * Evidence validation: the only thing between a fluent model and the reader.
 *
 * Everything a model writes is untrusted, so this module never takes the
 * model's word for anything:
 *
 * - A point's own `confidence` is a claim, not a fact. A point that cites
 *   nothing is downgraded, even when it says `high`.
 * - A snippet is never checked against the model's text. It is looked up in the
 *   canonical form of the file on disk, produced by the same
 *   `canonicalizeFile` the model's slice came from, so the two sides cannot
 *   disagree about a BOM, a CRLF or an encoding fallback.
 *
 * Three outcomes, never conflated:
 *
 * - **wrong** — the file is missing or outside the root, the snippet is not a
 *   verbatim substring, or the snippet's own line range is not the reported
 *   one. The point is dropped; its evidence is counted in
 *   `stats.droppedEvidence`.
 * - **missing** — no evidence survived, or a `high` point cites nothing. The
 *   point is kept, downgraded to `low`, and told why in `unknowns`.
 * - **ok** — kept, with ids stamped by this module instead of the model.
 *
 * Malformed model output never throws: a broken point is dropped with a reason,
 * because one bad point must not cost the whole report.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import type {
  CanonicalFile,
  Evidence,
  LearningPoint,
  ValidationResult,
} from '../contracts/types.js'
import { canonicalizeFile, lineRangeOfSnippet } from './canonicalize.js'

/** The unknown every downgraded point carries. Shared so it stays one string. */
export const NO_VERIFIABLE_EVIDENCE = 'no verifiable evidence'

const CONFIDENCES: readonly string[] = ['high', 'medium', 'low']

/**
 * `runId` plus the first six hex characters of `sha256(path + "\0" + line)`.
 *
 * The NUL is what keeps `a1:23` from hashing the same as `a12:3`; the prefix is
 * short because the id is read by humans, and a 24-bit space is enough to tell
 * the handful of evidence items in one report apart.
 */
export function evidenceId(runId: string, filePath: string, startLine: number): string {
  const digest = createHash('sha256').update(`${filePath}\0${startLine}`).digest('hex')
  return `${runId}-${digest.slice(0, 6)}`
}

/** A canonical file, or why it could not be read as one. */
type Lookup =
  | { file: CanonicalFile; relPath: string }
  | { failure: string }

type Verdict = { ok: true; evidence: Evidence } | { ok: false; reason: string }

/**
 * Resolves evidence paths and canonicalizes each file **at most once** per
 * `validatePoints` call.
 *
 * A path that escapes `root` — absolute, or `..` climbing out — is refused
 * before any read: evidence pointing at `/etc/passwd` is wrong evidence, not a
 * crash and not a file read.
 */
function createLookup(root: string): (evidencePath: string) => Promise<Lookup> {
  const cache = new Map<string, Promise<Lookup>>()

  return (evidencePath: string): Promise<Lookup> => {
    if (path.isAbsolute(evidencePath)) {
      return Promise.resolve({ failure: `evidence path is absolute: ${evidencePath}` })
    }

    const abs = path.resolve(root, evidencePath)
    const rel = path.relative(root, abs)
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return Promise.resolve({
        failure: `evidence path escapes the analysed root: ${evidencePath}`,
      })
    }

    const cached = cache.get(abs)
    if (cached !== undefined) return cached

    const pending: Promise<Lookup> = canonicalizeFile(abs).then(
      (file): Lookup => ({ file, relPath: rel.split(path.sep).join('/') }),
      (error: unknown): Lookup => ({
        failure: isNotFound(error)
          ? `evidence file not found: ${evidencePath}`
          : `evidence file could not be read: ${evidencePath}`,
      }),
    )
    cache.set(abs, pending)
    return pending
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Checks one snippet against the canonical text of its file.
 *
 * Bounds are asserted explicitly. `offsetOfLine` throws one line too late for
 * this job: a text ending in `\n` has one extra addressable line start, so a
 * citation of the nonexistent trailing empty line would be accepted on nearly
 * every source file.
 */
async function verifyEvidence(
  raw: unknown,
  lookup: (evidencePath: string) => Promise<Lookup>,
  runId: string,
): Promise<Verdict> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'evidence is not an object' }
  }

  const fields = raw as Record<string, unknown>
  const evidencePath = fields['path']
  const startLine = fields['startLine']
  const endLine = fields['endLine']
  const snippet = fields['snippet']

  if (typeof evidencePath !== 'string' || evidencePath === '') {
    return { ok: false, reason: 'evidence has no path' }
  }
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return {
      ok: false,
      reason: `evidence ${evidencePath} has non-integer line numbers`,
    }
  }
  if (typeof snippet !== 'string' || snippet.trim() === '') {
    return { ok: false, reason: `evidence ${evidencePath}:${startLine} has an empty snippet` }
  }

  const start = startLine as number
  const end = endLine as number
  const found = await lookup(evidencePath)
  if ('failure' in found) return { ok: false, reason: found.failure }

  const { file, relPath } = found
  if (start < 1 || end < start || end > file.lineCount) {
    return {
      ok: false,
      reason:
        `evidence ${relPath} lines ${start}..${end} are outside 1..${file.lineCount}`,
    }
  }

  if (!snippet.includes('\n')) {
    // A single-line snippet is checked against its own line: saying "lines 4..9"
    // about one line is not evidence of anything.
    if (start !== end) {
      return {
        ok: false,
        reason: `single-line snippet in ${relPath} claims lines ${start}..${end}`,
      }
    }
    const line = file.text.split('\n')[start - 1] ?? ''
    if (!line.includes(snippet)) {
      return { ok: false, reason: `snippet is not on line ${start} of ${relPath}` }
    }
  } else {
    const range = lineRangeOfSnippet(file.text, snippet)
    if (range === null) {
      return { ok: false, reason: `snippet is not in ${relPath}` }
    }
    if (range.startLine !== start || range.endLine !== end) {
      return {
        ok: false,
        reason:
          `snippet in ${relPath} is on lines ${range.startLine}..${range.endLine}, ` +
          `not ${start}..${end}`,
      }
    }
  }

  return {
    ok: true,
    evidence: {
      id: evidenceId(runId, relPath, start),
      path: relPath,
      startLine: start,
      endLine: end,
      snippet,
    },
  }
}

function pointIdOf(raw: unknown, index: number): string {
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as Record<string, unknown>)['id']
    if (typeof id === 'string' && id !== '') return id
  }
  return `<point#${index}>`
}

type Shape = { point: LearningPoint } | { reason: string }

/**
 * The structural check, before any file is touched.
 *
 * Deliberately shallow: the fields this module reads and rewrites
 * (`id`, `theirs.evidence`, `confidence`) must be sound, and the rest of the
 * point is passed through untouched. A point that cannot be validated at all is
 * dropped here rather than half-processed.
 */
function checkShape(raw: unknown): Shape {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: 'point is not an object' }
  }

  const fields = raw as Record<string, unknown>
  const id = fields['id']
  if (typeof id !== 'string' || id === '') return { reason: 'point has no id' }

  const theirs = fields['theirs']
  if (typeof theirs !== 'object' || theirs === null) {
    return { reason: `point ${id} has no theirs` }
  }
  if (!Array.isArray((theirs as Record<string, unknown>)['evidence'])) {
    return { reason: `point ${id} has no evidence array` }
  }

  const confidence = fields['confidence']
  if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence)) {
    return {
      reason: `point ${id} has confidence ${String(confidence)}, not high|medium|low`,
    }
  }

  return { point: raw as LearningPoint }
}

/** `Math.round(x * 100) / 100`, without the usual float noise in between. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Validates every point of a model answer against the tree at `root`.
 *
 * `runId` only appears in the evidence ids this function mints; the trees are
 * the authority for everything else.
 */
export async function validatePoints(
  points: LearningPoint[],
  root: string,
  runId: string,
): Promise<ValidationResult> {
  const lookup = createLookup(path.resolve(root))
  const list: unknown[] = Array.isArray(points) ? points : []

  const kept: LearningPoint[] = []
  const downgraded: ValidationResult['downgraded'] = []
  const dropped: ValidationResult['dropped'] = []
  let droppedEvidence = 0
  let verifiedPoints = 0
  let evidenceTotal = 0

  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    const pointId = pointIdOf(raw, index)

    const shape = checkShape(raw)
    if ('reason' in shape) {
      dropped.push({ pointId, reason: shape.reason })
      continue
    }

    const point = shape.point
    const submitted = point.theirs.evidence as unknown[]
    const verified: Evidence[] = []
    const failures: string[] = []

    for (const item of submitted) {
      const verdict = await verifyEvidence(item, lookup, runId)
      if (verdict.ok) verified.push(verdict.evidence)
      else failures.push(verdict.reason)
    }

    if (failures.length > 0) {
      // Every failing item is counted, so the stats say how much of the model's
      // evidence was invented rather than merely how many points died.
      droppedEvidence += failures.length
      const [first, ...rest] = failures
      dropped.push({
        pointId,
        reason: rest.length === 0 ? (first as string) : `${first} (+${rest.length} more)`,
      })
      continue
    }

    if (verified.length === 0) {
      const known = Array.isArray(point.unknowns)
        ? point.unknowns.filter((unknown) => typeof unknown === 'string')
        : []
      const unknowns = known.includes(NO_VERIFIABLE_EVIDENCE)
        ? known
        : [...known, NO_VERIFIABLE_EVIDENCE]

      kept.push({
        ...point,
        confidence: 'low',
        unknowns,
        theirs: { ...point.theirs, evidence: [] },
      })
      downgraded.push({ pointId, reason: NO_VERIFIABLE_EVIDENCE })
      continue
    }

    kept.push({ ...point, theirs: { ...point.theirs, evidence: verified } })
    verifiedPoints += 1
    evidenceTotal += verified.length
  }

  const keptCount = kept.length
  return {
    kept,
    downgraded,
    dropped,
    stats: {
      // A point kept on zero evidence has nothing verified, so it cannot count
      // as evidence-backed: the rate is what a reader should trust.
      evidenceRate: keptCount === 0 ? 0 : verifiedPoints / keptCount,
      droppedEvidence,
      avgEvidence: keptCount === 0 ? 0 : round2(evidenceTotal / keptCount),
    },
  }
}
