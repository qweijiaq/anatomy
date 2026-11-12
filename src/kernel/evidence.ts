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
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type {
  CanonicalFile,
  Evidence,
  LearningPoint,
  Scope,
  ValidationResult,
} from '../contracts/types.js'
import { canonicalizeFile } from './canonicalize.js'

/** The unknown every downgraded point carries. Shared so it stays one string. */
export const NO_VERIFIABLE_EVIDENCE = 'no verifiable evidence'

/**
 * The largest file this module will read to check a snippet.
 *
 * Evidence is a quotation from source; no snippet is worth buffering a lockfile,
 * a bundle or an excluded binary into the run. 1 MiB is far above any file a
 * point can usefully cite and far below anything that would hurt to decode.
 */
export const MAX_EVIDENCE_BYTES = 1024 * 1024

const CONFIDENCES: readonly string[] = ['high', 'medium', 'low']

const KINDS: readonly string[] = [
  'architecture',
  'algorithm',
  'data-model',
  'api-design',
  'performance',
  'testing',
  'tooling',
  'process',
]

/**
 * What makes a snippet worth being called evidence: length, not punctuation.
 *
 * A single character always appears somewhere in a file, so a one-letter
 * "quote" would certify any point — a fabricated one included. Eight
 * non-whitespace characters is enough for `n * 2`-sized code fragments to fail
 * closed, unless they carry a word or a name of three characters or more.
 */
const MIN_SNIPPET_NON_WHITESPACE = 8
/** A word, a name or a number on its own is evidence even when short. */
const ALNUM_RUN = /[A-Za-z0-9]{3,}/

function isSubstantial(snippet: string): boolean {
  const dense = snippet.replace(/\s+/g, '')
  return dense.length >= MIN_SNIPPET_NON_WHITESPACE || ALNUM_RUN.test(dense)
}

/** 1-based number of the line that holds the character at `index`. */
function lineOfIndex(text: string, index: number): number {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) {
    line += 1
  }
  return line
}

/**
 * The line range a snippet occupies when it matches at `index`.
 *
 * A leading newline still belongs to the line it terminates and a trailing one
 * to the line it ends, so neither lengthens the range. The lines are counted
 * from the match offset itself rather than from the text before it: a match
 * that starts mid-line is on that line, not on the next one.
 */
function rangeOfMatch(
  text: string,
  index: number,
  snippet: string,
): { startLine: number; endLine: number } {
  const matched = text.slice(index, index + snippet.length)
  let newlines = 0
  for (let at = matched.indexOf('\n'); at !== -1; at = matched.indexOf('\n', at + 1)) {
    newlines += 1
  }

  const startLine = lineOfIndex(text, index)
  const endLine = matched.endsWith('\n') ? startLine + newlines - 1 : startLine + newlines
  return { startLine, endLine: Math.max(startLine, endLine) }
}

/**
 * The range of the occurrence of `snippet` that covers lines `start..end`.
 *
 * Every occurrence is considered, because duplicated code is cited from
 * wherever the model saw it: taking the first occurrence's range would drop an
 * honest citation of the second copy. The scan stops once an occurrence begins
 * after `end`: later ones can only be further away.
 */
function rangeOfCitedOccurrence(
  text: string,
  snippet: string,
  start: number,
  end: number,
): { accepted: true } | { accepted: false; first: { startLine: number; endLine: number } | null } {
  let first: { startLine: number; endLine: number } | null = null

  for (let at = text.indexOf(snippet); at !== -1; at = text.indexOf(snippet, at + 1)) {
    const range = rangeOfMatch(text, at, snippet)
    if (first === null) first = range
    if (range.startLine === start && range.endLine === end) return { accepted: true }
    if (range.startLine > end) break
  }

  return { accepted: false, first }
}

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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** Whether `child` is `parent` or lies inside it. Both must already be resolved. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * Resolves a candidate path, checks what it really is, and reads it.
 *
 * The lexical check upstream only proves the *spelling* stays inside the root.
 * A symlink does not: `vendor/link/.ssh/id_rsa` reads as an in-tree path and
 * opens a file outside the tree, and a symlink to a FIFO or a device hangs or
 * exhausts memory rather than returning bytes. So the real path is resolved and
 * containment is decided again on the resolved pair, and what is left must be a
 * regular file under the size cap. `realpath` followed by `stat` on the resolved
 * path, then a read of that same resolved path, leaves no window in which a link
 * can be repointed between the check and the read.
 */
async function readVerified(
  abs: string,
  realRoot: string,
  relPath: string,
  evidencePath: string,
): Promise<Lookup> {
  let real: string
  try {
    real = await realpath(abs)
  } catch (error) {
    return {
      failure: isNotFound(error)
        ? `evidence file not found: ${evidencePath}`
        : `evidence path cannot be resolved: ${evidencePath}`,
    }
  }

  if (!isInside(realRoot, real)) {
    return {
      failure: `evidence path resolves outside the analysed root: ${evidencePath}`,
    }
  }

  let size: number
  try {
    const info = await stat(real)
    if (!info.isFile()) {
      return { failure: `evidence path is not a regular file: ${evidencePath}` }
    }
    size = info.size
  } catch (error) {
    return {
      failure: isNotFound(error)
        ? `evidence file not found: ${evidencePath}`
        : `evidence file could not be read: ${evidencePath}`,
    }
  }

  // Checked before the read, so the bytes of a huge file are never buffered.
  if (size > MAX_EVIDENCE_BYTES) {
    return {
      failure:
        `evidence file ${relPath} is ${size} bytes, over the ` +
        `${MAX_EVIDENCE_BYTES} byte read cap`,
    }
  }

  try {
    return { file: await canonicalizeFile(real), relPath }
  } catch (error) {
    return {
      failure: isNotFound(error)
        ? `evidence file not found: ${evidencePath}`
        : `evidence file could not be read: ${evidencePath}`,
    }
  }
}

/**
 * Resolves evidence paths and canonicalizes each file **at most once** per
 * `validatePoints` call.
 *
 * Refused before any read, in this order: an absolute path; a path whose
 * lexical form escapes `root` (`..` climbing out — evidence pointing at
 * `/etc/passwd` is wrong evidence, not a crash and not a file read); a path the
 * analysed `Scope` does not list, when a scope is given, because a lockfile or
 * an excluded binary is not evidence of anything.
 */
async function createLookup(
  root: string,
  scope?: Scope,
): Promise<(evidencePath: string) => Promise<Lookup>> {
  const cache = new Map<string, Promise<Lookup>>()
  const realRoot = await realpath(root).catch(() => null)
  const inScope =
    scope === undefined ? null : new Set(scope.files.map((file) => file.path))

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

    const relPath = rel.split(path.sep).join('/')
    if (inScope !== null && !inScope.has(relPath)) {
      return Promise.resolve({
        failure: `evidence path is outside the analysed scope: ${evidencePath}`,
      })
    }

    if (realRoot === null) {
      return Promise.resolve({ failure: `evidence root cannot be resolved: ${root}` })
    }

    const cached = cache.get(abs)
    if (cached !== undefined) return cached

    const pending = readVerified(abs, realRoot, relPath, evidencePath)
    cache.set(abs, pending)
    return pending
  }
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
  const rawSnippet = fields['snippet']

  if (typeof evidencePath !== 'string' || evidencePath === '') {
    return { ok: false, reason: 'evidence has no path' }
  }
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return {
      ok: false,
      reason: `evidence ${evidencePath} has non-integer line numbers`,
    }
  }
  if (typeof rawSnippet !== 'string') {
    return { ok: false, reason: `evidence ${evidencePath}:${startLine} has an empty snippet` }
  }

  // Canonical text never contains `\r`, so a model that echoes a CRLF file back
  // at us would otherwise lose correct evidence to its own line endings.
  const snippet = rawSnippet.replace(/\r\n?/g, '\n')
  if (snippet.trim() === '') {
    return { ok: false, reason: `evidence ${evidencePath}:${startLine} has an empty snippet` }
  }
  if (!isSubstantial(snippet)) {
    return {
      ok: false,
      reason: `evidence ${evidencePath}:${startLine} is too short to be evidence`,
    }
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
    const cited = rangeOfCitedOccurrence(file.text, snippet, start, end)
    if (!cited.accepted) {
      const first = cited.first
      return {
        ok: false,
        reason:
          first === null
            ? `snippet is not in ${relPath}`
            : `snippet in ${relPath} is on lines ${first.startLine}..${first.endLine}, ` +
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Every element of `value` is an object whose listed keys are all strings. */
function everyRecordWithStrings(value: unknown, keys: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) && keys.every((key) => typeof item[key] === 'string'),
    )
  )
}

/**
 * The structural check, before any file is touched.
 *
 * Every field the report renders is checked, not just the two this module
 * rewrites. A point is a contract with the renderer: a `title` that is 42 or an
 * `alternatives: null` is not a low-confidence point, it is a crash waiting for
 * `.alternatives.map` two stages later, so it is dropped here with a reason
 * naming the field.
 */
function checkShape(raw: unknown): Shape {
  if (!isRecord(raw)) return { reason: 'point is not an object' }

  const id = raw['id']
  if (typeof id !== 'string' || id === '') return { reason: 'point has no id' }

  if (typeof raw['title'] !== 'string' || raw['title'].trim() === '') {
    return { reason: `point ${id} has no title` }
  }

  const kind = raw['kind']
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    return { reason: `point ${id} has kind ${String(kind)}, not one of ${KINDS.join('|')}` }
  }

  const problem = raw['problem']
  if (
    !isRecord(problem) ||
    typeof problem['constraint'] !== 'string' ||
    typeof problem['stakes'] !== 'string'
  ) {
    return { reason: `point ${id} has no usable problem { constraint, stakes }` }
  }

  if (!everyRecordWithStrings(raw['alternatives'], ['approach', 'cost'])) {
    return { reason: `point ${id} has no usable alternatives { approach, cost }[]` }
  }

  const theirs = raw['theirs']
  if (!isRecord(theirs)) return { reason: `point ${id} has no theirs` }
  if (typeof theirs['summary'] !== 'string') {
    return { reason: `point ${id} has no theirs.summary` }
  }
  // A missing evidence array is a shape error; an empty one is a claim this
  // module downgrades rather than drops, so the two must stay apart.
  if (!Array.isArray(theirs['evidence'])) {
    return { reason: `point ${id} has no evidence array` }
  }

  if (typeof raw['mechanism'] !== 'string') {
    return { reason: `point ${id} has no mechanism` }
  }

  if (!everyRecordWithStrings(raw['tradeoffs'], ['cost', 'whenItHurts'])) {
    return { reason: `point ${id} has no usable tradeoffs { cost, whenItHurts }[]` }
  }

  const confidence = raw['confidence']
  const normalized = typeof confidence === 'string' ? confidence.trim().toLowerCase() : ''
  if (typeof confidence !== 'string' || !CONFIDENCES.includes(normalized)) {
    return {
      reason: `point ${id} has confidence ${String(confidence)}, not high|medium|low`,
    }
  }

  if (!isStringArray(raw['unknowns'])) {
    return { reason: `point ${id} has no unknowns string[]` }
  }

  const recipe = raw['recipe']
  if (
    recipe !== null &&
    !(
      isRecord(recipe) &&
      isStringArray(recipe['prereqs']) &&
      typeof recipe['minimalForm'] === 'string' &&
      isStringArray(recipe['avoidWhen'])
    )
  ) {
    return { reason: `point ${id} has no usable recipe { prereqs, minimalForm, avoidWhen }` }
  }

  // The point is kept with the confidence this module understood, not with the
  // spelling the model used: `High` must not survive into the report.
  return { point: { ...(raw as LearningPoint), confidence: normalized as LearningPoint['confidence'] } }
}

/** `Math.round(x * 100) / 100`, without the usual float noise in between. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Validates every point of a model answer against the tree at `root`.
 *
 * `runId` only appears in the evidence ids this function mints; the trees are
 * the authority for everything else. `scope`, when given, is the second
 * authority: a file the analysis excluded is not citable, so the point cannot
 * be backed by a lockfile or a vendored bundle the rest of the run ignores.
 * Optional so a caller that has no scope keeps working.
 */
export async function validatePoints(
  points: LearningPoint[],
  root: string,
  runId: string,
  scope?: Scope,
): Promise<ValidationResult> {
  const lookup = await createLookup(path.resolve(root), scope)
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
    const verifiedIds = new Set<string>()
    const failures: string[] = []

    for (const item of submitted) {
      const verdict = await verifyEvidence(item, lookup, runId)
      if (!verdict.ok) {
        failures.push(verdict.reason)
        continue
      }
      // Repeating one real snippet five times is not five pieces of evidence,
      // and untrusted input must not be able to move the trust stats.
      const evidence = verdict.evidence
      if (verifiedIds.has(evidence.id)) continue
      verifiedIds.add(evidence.id)
      verified.push(evidence)
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
