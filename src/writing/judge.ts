/**
 * Candidates in, checked learning points out.
 *
 * This layer's whole job is to keep the model's freedom away from the product's
 * claims. It reads a small, bounded window around each candidate (the
 * candidate's own code, the file's imports, at most two direct relative
 * dependencies) so the prompt contains what the decision needs and not the
 * file it lives in. Everything else is refusal:
 *
 * - a reply that is not the requested JSON, or is the wrong shape, gets exactly
 *   one repair attempt and is then skipped with a reason, never retried forever;
 * - an exhausted transport failure is not a bad reply and is not retried here;
 * - a missing key aborts the run instead of quietly skipping every candidate;
 * - a point may only be backed by the lines the prompt actually showed. The
 *   model cannot see the rest of the file, so a citation outside that window is
 *   dropped before validation even though the snippet really is on disk;
 * - containment is decided on the `realpath` of every file that is read, and a
 *   file is decoded once per run however many windows are cut out of it;
 * - the surviving points still go through `validatePoints`, always, with the
 *   caller's scope. This module never returns a point that Task 10 has not
 *   looked at, so no caller can forget.
 */

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type {
  Candidate,
  CanonicalFile,
  Judgement,
  LearningPoint,
  Scope,
  Slice,
  ValidationResult,
} from '../contracts/types.js'
import { canonicalizeFile, sliceOf } from '../kernel/canonicalize.js'
import { validatePoints } from '../kernel/evidence.js'
import type { ModelClient, ModelRequest, Usage } from './client.js'
import { MissingCredentialsError, ModelReplyError, ModelRequestError } from './client.js'
import type { Lang } from './prompts/zh.js'
import {
  CONFIDENCES,
  POINT_KINDS,
  POINT_SCHEMA,
  candidateHeader,
  noSlices,
  repairNote,
  sliceElision,
  sliceHeader,
  slicesHeading,
  systemPrompt,
} from './prompts/zh.js'

/** Lines of the candidate's own file shown before its line. */
const CANDIDATE_BEFORE = 12
/** Lines of the candidate's own file shown after its line. */
const CANDIDATE_AFTER = 60
/** Lines read from the top of a file to find its imports. */
const IMPORT_HEAD_LINES = 40
/** Lines read from the top of a direct dependency. */
const DEPENDENCY_HEAD_LINES = 60
const MAX_DEPENDENCIES = 2
/** One first attempt plus one repair. A third wrong reply is not a prompt bug. */
const MAX_REPLY_ATTEMPTS = 2
/** The longest model-authored fragment echoed back in a repair instruction. */
const MAX_REASON_CHARS = 200

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

export type SkippedCandidate = {
  candidateId: string
  path: string
  line: number
  reason: string
}

export type JudgeResult = Judgement & {
  validation: ValidationResult
  skipped: SkippedCandidate[]
  /**
   * Candidates no usable reply came back for — prose where JSON was asked, an empty
   * message, a shape that could not be read even after the repair attempt.
   *
   * Kept apart from `skipped` because a skip is an answer and this is a failure. A
   * run where every reply was unusable produces zero points, exactly like a repository
   * with nothing to learn, and the two must not report the same thing.
   */
  replyFailures: number
}

export type JudgeDeps = {
  client: ModelClient
  root: string
  candidates: Candidate[]
  /** The analysed scope, forwarded to `validatePoints`. */
  scope?: Scope
  lang?: Lang
  /** Maximum number of candidates to judge. The rest are reported, not hidden. */
  limit?: number
  /**
   * Called once per distinct provider failure, with what the provider actually said.
   *
   * The report records "model request failed: HTTP 400" and no more, because provider
   * bodies are untrusted text that ends up in a document. The person running the
   * command is not a document, and a status code with no explanation is not a
   * diagnosis — it is what made a real DeepSeek run unreadable until the body was
   * fetched by hand.
   */
  onProviderError?: (detail: { status: number | null; excerpt: string }) => void
  /**
   * Prefix for the evidence ids minted by `validatePoints`. Required: a default
   * here would stamp every id in every report with a run that never happened.
   */
  runId: string
  /**
   * Called before each candidate is judged, with how far along the queue is.
   *
   * Judging is the long stage — one model call per candidate, minutes of wall
   * clock — and without this the UI can only say "分析中", which is
   * indistinguishable from a hang.
   */
  onCandidate?: (done: number, total: number, path: string) => void
}

// --- prompt ---------------------------------------------------------------

function lineLabel(line: number, text: string): string {
  return `${line} | ${text}`
}

/**
 * One slice as labelled text.
 *
 * The line numbers come from the slice's own `startLine` / `omitted` /
 * `endLine`, never from counting the text: a truncated slice has fewer text
 * lines than the span it covers, and counting would silently renumber the tail
 * into the elided range the model is forbidden to cite.
 */
function renderSlice(slice: Slice, lang: Lang): string {
  const header = sliceHeader(lang, slice)
  const lines = slice.text.split('\n')

  if (!slice.truncated || slice.omitted === null) {
    const body = lines.map((line, index) => lineLabel(slice.startLine + index, line)).join('\n')
    return `${header}\n${body}`
  }

  const omitted = slice.omitted
  const headCount = Math.max(0, Math.min(omitted.startLine - slice.startLine, lines.length))
  const head = lines
    .slice(0, headCount)
    .map((line, index) => lineLabel(slice.startLine + index, line))
  const tailStart = headCount < lines.length ? headCount + 1 : lines.length
  const tail = lines
    .slice(tailStart)
    .map((line, index) => lineLabel(omitted.endLine + 1 + index, line))

  return [header, ...head, sliceElision(lang, omitted), ...tail].join('\n')
}

/** The prompt a single candidate is judged with. Pure: no disk, no network. */
export function buildJudgePrompt(
  candidate: Candidate,
  slices: Slice[],
  lang: Lang = 'zh',
): { system: string; user: string } {
  const body = slices.length === 0 ? noSlices(lang) : slices.map((s) => renderSlice(s, lang)).join('\n\n')
  return {
    system: systemPrompt(lang),
    user: `${candidateHeader(lang, candidate)}\n\n${slicesHeading(lang)}\n${body}`,
  }
}

// --- reply shape ----------------------------------------------------------

type ParsedReply = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecordArray(value: unknown, keys: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && keys.every((key) => typeof item[key] === 'string'))
  )
}

/** JSON text is accepted as well as an already-parsed object. */
function parseReply(raw: unknown): ParsedReply {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, reason: 'the reply is not JSON' }
    }
  }
  if (!isRecord(value)) return { ok: false, reason: 'the reply is not a JSON object' }
  return { ok: true, value }
}

function evidenceShapeProblem(evidence: unknown, pointLabel: string): string | null {
  if (!Array.isArray(evidence)) return `point ${pointLabel} has no evidence array`
  for (const item of evidence) {
    if (!isRecord(item)) return `point ${pointLabel} has an evidence item that is not an object`
    if (typeof item['path'] !== 'string' || item['path'] === '') {
      return `point ${pointLabel} has an evidence item with no path`
    }
    if (!Number.isInteger(item['startLine']) || !Number.isInteger(item['endLine'])) {
      return `point ${pointLabel} has an evidence item with non-integer line numbers`
    }
    if (typeof item['snippet'] !== 'string') {
      return `point ${pointLabel} has an evidence item with no snippet`
    }
  }
  return null
}

type ParsedPoint = { ok: true; point: LearningPoint } | { ok: false; reason: string }

/**
 * Structural validation only; truth is Task 10's job.
 *
 * `id` falls back to the candidate and an omitted `confidence` falls back to
 * `medium`, because neither is a claim about the code. Everything the report
 * renders is required, so a malformed point is retried instead of crashing two
 * stages later.
 */
function parsePoint(value: Record<string, unknown>, candidate: Candidate): ParsedPoint {
  const label = typeof value['id'] === 'string' && value['id'] !== '' ? value['id'] : candidate.id

  const title = value['title']
  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, reason: `point ${label} has no usable title` }
  }

  const kind = value['kind']
  if (typeof kind !== 'string' || !(POINT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `point ${label} has no usable kind` }
  }

  const problem = value['problem']
  if (
    !isRecord(problem) ||
    typeof problem['constraint'] !== 'string' ||
    typeof problem['stakes'] !== 'string'
  ) {
    return { ok: false, reason: `point ${label} has no usable problem { constraint, stakes }` }
  }

  if (!isRecordArray(value['alternatives'], ['approach', 'cost'])) {
    return { ok: false, reason: `point ${label} has no usable alternatives { approach, cost }[]` }
  }

  const theirs = value['theirs']
  if (!isRecord(theirs) || typeof theirs['summary'] !== 'string') {
    return { ok: false, reason: `point ${label} has no usable theirs { summary, evidence }` }
  }
  const evidenceProblem = evidenceShapeProblem(theirs['evidence'], label)
  if (evidenceProblem !== null) return { ok: false, reason: evidenceProblem }

  if (typeof value['mechanism'] !== 'string') {
    return { ok: false, reason: `point ${label} has no mechanism` }
  }

  if (!isRecordArray(value['tradeoffs'], ['cost', 'whenItHurts'])) {
    return { ok: false, reason: `point ${label} has no usable tradeoffs { cost, whenItHurts }[]` }
  }

  const rawConfidence = value['confidence']
  let confidence: LearningPoint['confidence'] = 'medium'
  if (rawConfidence !== undefined && rawConfidence !== null) {
    if (typeof rawConfidence !== 'string') {
      return { ok: false, reason: `point ${label} has a non-string confidence` }
    }
    if (rawConfidence.trim() !== '') {
      const normalized = rawConfidence.trim().toLowerCase()
      if (!(CONFIDENCES as readonly string[]).includes(normalized)) {
        return { ok: false, reason: `point ${label} has confidence ${rawConfidence}, not high|medium|low` }
      }
      confidence = normalized as LearningPoint['confidence']
    }
  }

  const rawUnknowns = value['unknowns']
  if (rawUnknowns !== undefined && !isStringArray(rawUnknowns)) {
    return { ok: false, reason: `point ${label} has no unknowns string[]` }
  }

  const rawRecipe = value['recipe']
  if (
    rawRecipe !== undefined &&
    rawRecipe !== null &&
    !(
      isRecord(rawRecipe) &&
      isStringArray(rawRecipe['prereqs']) &&
      typeof rawRecipe['minimalForm'] === 'string' &&
      isStringArray(rawRecipe['avoidWhen'])
    )
  ) {
    return { ok: false, reason: `point ${label} has no usable recipe { prereqs, minimalForm, avoidWhen }` }
  }

  return {
    ok: true,
    point: {
      id: typeof value['id'] === 'string' && value['id'] !== '' ? value['id'] : candidate.id,
      title,
      kind: kind as LearningPoint['kind'],
      problem: {
        constraint: problem['constraint'] as string,
        stakes: problem['stakes'] as string,
      },
      alternatives: value['alternatives'] as LearningPoint['alternatives'],
      theirs: {
        summary: theirs['summary'] as string,
        evidence: theirs['evidence'] as LearningPoint['theirs']['evidence'],
      },
      mechanism: value['mechanism'] as string,
      tradeoffs: value['tradeoffs'] as LearningPoint['tradeoffs'],
      confidence,
      unknowns: (rawUnknowns as string[] | undefined) ?? [],
      recipe: (rawRecipe as LearningPoint['recipe'] | undefined) ?? null,
    },
  }
}

// --- context slices -------------------------------------------------------

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

/** How a citation is matched to a slice: posix, relative, `.` segments folded. */
function citationKey(filePath: string): string {
  return path.posix.normalize(toPosix(filePath)).replace(/^\.\//, '')
}

/** Repo-relative posix path of a candidate, or `null` when it escapes the root. */
function repoRelative(root: string, candidatePath: string): string | null {
  if (candidatePath === '' || path.isAbsolute(candidatePath)) return null
  const abs = path.resolve(root, candidatePath)
  const rel = path.relative(path.resolve(root), abs)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null
  }
  return toPosix(rel)
}

/** Whether `child` is `parent` or lies inside it. Both must already be resolved. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * One judge run's view of the tree.
 *
 * `root` is resolved once, so every other path in this module — and every slice
 * path in the prompt — is resolved against the same root. `realRoot` is what
 * containment is decided on: the lexical form `path.resolve` returns never
 * follows a symlink, and a symlink is how out-of-tree bytes would otherwise be
 * read and uploaded. The two maps make both of those answers cost one syscall
 * per file per run instead of one per candidate window.
 */
type JudgeContext = {
  root: string
  realRoot: string
  /** One decode per file per run: several windows cut from the same file. */
  files: Map<string, Promise<CanonicalFile>>
  /** One `realpath` per spelled path per run. */
  real: Map<string, Promise<string | null>>
  /** `scope.files`, or `null` when the caller gave no scope. */
  inScope: Set<string> | null
}

async function createContext(root: string, scope?: Scope): Promise<JudgeContext> {
  const resolvedRoot = path.resolve(root)
  return {
    root: resolvedRoot,
    realRoot: (await realpath(resolvedRoot).catch(() => null)) ?? resolvedRoot,
    files: new Map(),
    real: new Map(),
    inScope: scope === undefined ? null : new Set(scope.files.map((file) => file.path)),
  }
}

async function fileOf(ctx: JudgeContext, abs: string): Promise<CanonicalFile> {
  const cached = ctx.files.get(abs)
  if (cached !== undefined) return cached
  const pending = canonicalizeFile(abs)
  ctx.files.set(abs, pending)
  return pending
}

/**
 * The real path of `abs`, when it is a regular file inside the analysed tree.
 *
 * The checks above and in `resolveSpecifier` only prove the *spelling* stays
 * inside the root. A symlink does not: `import './link.js'` where `link.js`
 * points at `~/.aws/credentials` reads as an in-tree dependency and would upload
 * the target to the model provider. So the real path is resolved, containment is
 * decided on the resolved pair, and only a regular file is ever read — `stat` on
 * the realpath also keeps a symlink to a FIFO from hanging the run.
 */
async function realFileInside(ctx: JudgeContext, abs: string): Promise<string | null> {
  const cached = ctx.real.get(abs)
  if (cached !== undefined) return cached

  const pending = (async (): Promise<string | null> => {
    let real: string
    try {
      real = await realpath(abs)
    } catch {
      return null
    }
    if (!isInside(ctx.realRoot, real)) return null
    try {
      return (await stat(real)).isFile() ? real : null
    } catch {
      return null
    }
  })()

  ctx.real.set(abs, pending)
  return pending
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile()
  } catch {
    return false
  }
}

const IMPORT_SPECIFIER =
  /\bfrom\s*['"]([^'"\n]+)['"]|\brequire\s*\(\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]|\bimport\s+['"]([^'"\n]+)['"]/g

function importSpecifiers(text: string): string[] {
  const found: string[] = []
  const pattern = new RegExp(IMPORT_SPECIFIER.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (specifier !== undefined && specifier !== '') found.push(specifier)
  }
  return found
}

/**
 * Resolves a relative import to a real file inside the root.
 *
 * Bare specifiers are not dependencies of the analysed repository: reading
 * `node_modules` would spend tokens on code the reader did not write. `.js`
 * specifiers are also tried as `.ts`, because that is how ESM TypeScript is
 * written.
 */
async function resolveSpecifier(
  root: string,
  fromPath: string,
  specifier: string,
): Promise<string | null> {
  if (!specifier.startsWith('.')) return null

  const base = path.resolve(root, path.dirname(fromPath), specifier)
  const rel = path.relative(root, base)
  if (rel === '' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null

  const attempts: string[] = [base]
  const esm = /\.(?:js|jsx|mjs|cjs)$/.exec(base)
  if (esm !== null) {
    const stem = base.slice(0, -esm[0].length)
    attempts.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`)
  }
  for (const extension of CODE_EXTENSIONS) attempts.push(`${base}${extension}`)
  for (const extension of CODE_EXTENSIONS) attempts.push(path.join(base, `index${extension}`))

  for (const attempt of attempts) {
    if (!(await isFile(attempt))) continue
    const resolved = path.relative(root, attempt)
    if (resolved === '' || resolved.startsWith(`..${path.sep}`)) return null
    return toPosix(resolved)
  }
  return null
}

async function dependencySlices(
  ctx: JudgeContext,
  fromPath: string,
  headText: string,
): Promise<Slice[]> {
  const slices: Slice[] = []
  const seen = new Set<string>([fromPath])

  for (const specifier of importSpecifiers(headText)) {
    if (slices.length >= MAX_DEPENDENCIES) break
    const resolved = await resolveSpecifier(ctx.root, fromPath, specifier)
    if (resolved === null || seen.has(resolved)) continue
    // A dependency the analysis excluded is not context: its bytes would be
    // uploaded, and the evidence it invites would be dropped as out of scope.
    if (ctx.inScope !== null && !ctx.inScope.has(resolved)) continue
    seen.add(resolved)

    const real = await realFileInside(ctx, path.resolve(ctx.root, resolved))
    if (real === null) continue
    try {
      const slice = sliceOf(await fileOf(ctx, real), 1, DEPENDENCY_HEAD_LINES)
      if (slice.endLine === 0) continue
      slices.push({ ...slice, path: resolved })
    } catch {
      // A broken import is not a reason to fail the candidate.
    }
  }

  return slices
}

/**
 * The bounded context for one candidate: its own window (which includes the
 * imports when the candidate sits near the top) plus up to two dependencies.
 */
async function contextSlices(
  ctx: JudgeContext,
  candidatePath: string,
  line: number,
): Promise<Slice[]> {
  const real = await realFileInside(ctx, path.resolve(ctx.root, candidatePath))
  if (real === null) {
    throw new Error(`candidate file resolves outside the analysed root: ${candidatePath}`)
  }

  const file = await fileOf(ctx, real)
  const head = sliceOf(file, 1, IMPORT_HEAD_LINES)
  if (head.endLine === 0) return []

  const primaryStart = Math.max(1, line - CANDIDATE_BEFORE)
  const primaryEnd = line + CANDIDATE_AFTER
  const own =
    primaryStart <= head.endLine
      ? [sliceOf(file, 1, Math.max(head.endLine, primaryEnd))]
      : [head, sliceOf(file, primaryStart, primaryEnd)]

  const ownWithPath = own.map((slice) => ({ ...slice, path: candidatePath }))
  const dependencies = await dependencySlices(ctx, candidatePath, head.text)
  return [...ownWithPath, ...dependencies]
}

// --- what the model was actually shown ------------------------------------

/** The real line ranges a rendered slice exposes, with the elision removed. */
function shownRanges(slice: Slice): Array<[number, number]> {
  if (slice.startLine < 1 || slice.endLine < slice.startLine) return []
  if (!slice.truncated || slice.omitted === null) return [[slice.startLine, slice.endLine]]

  const ranges: Array<[number, number]> = []
  const headEnd = slice.omitted.startLine - 1
  if (headEnd >= slice.startLine) ranges.push([slice.startLine, headEnd])
  const tailStart = slice.omitted.endLine + 1
  if (slice.endLine >= tailStart) ranges.push([tailStart, slice.endLine])
  return ranges
}

/**
 * Every line range the prompt actually carried, per path.
 *
 * This is the difference between "the snippet exists" and "the model could have
 * read it". `validatePoints` can only prove the first; a citation of line 300
 * in a 2,000-line file whose prompt stopped at line 112 verifies there and is
 * still a claim the model invented.
 */
function shownWindows(slices: Slice[]): Map<string, Array<[number, number]>> {
  const windows = new Map<string, Array<[number, number]>>()
  for (const slice of slices) {
    const key = citationKey(slice.path)
    const ranges = windows.get(key) ?? []
    ranges.push(...shownRanges(slice))
    windows.set(key, ranges)
  }
  return windows
}

function isShown(
  windows: Map<string, Array<[number, number]>>,
  filePath: string,
  startLine: number,
  endLine: number,
): boolean {
  // A reversed range (`200..12`) is not a span the prompt could have shown, and
  // Task 10 rejects it as out of bounds; rejecting it here keeps the two gates
  // from disagreeing about what counts as a citation.
  if (startLine < 1 || endLine < startLine) return false
  const ranges = windows.get(citationKey(filePath))
  if (ranges === undefined) return false
  return ranges.some(([first, last]) => startLine >= first && endLine <= last)
}

/**
 * Drops every citation the prompt did not show.
 *
 * A point that loses all of its evidence is returned as-is minus that evidence,
 * so Task 10 downgrades it: silently keeping such a citation would present a
 * claim the model could not have read as one it verified.
 */
function keepShownEvidence(
  point: LearningPoint,
  windows: Map<string, Array<[number, number]>>,
): LearningPoint {
  const cited = point.theirs.evidence
  const shown = cited.filter((item) => isShown(windows, item.path, item.startLine, item.endLine))
  if (shown.length === cited.length) return point
  return { ...point, theirs: { ...point.theirs, evidence: shown } }
}

// --- judge ----------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim()
  return collapsed.length <= MAX_REASON_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_REASON_CHARS)}…`
}

/**
 * Judges every candidate, then validates the survivors.
 *
 * A bad reply costs one retry and one `skipped` entry, never a throw. The only
 * exceptions that escape are configuration failures (`MissingCredentialsError`)
 * and a scope that does not belong to the root, because both would otherwise
 * look like the model failing at every candidate.
 */
export async function judgeCandidates(deps: JudgeDeps): Promise<JudgeResult> {
  const lang: Lang = deps.lang ?? 'zh'
  const usage: Usage = { in: 0, out: 0 }
  const points: LearningPoint[] = []
  const skipped: SkippedCandidate[] = []
  let replyFailures = 0

  const limit =
    typeof deps.limit === 'number' && Number.isFinite(deps.limit)
      ? Math.max(0, Math.floor(deps.limit))
      : deps.candidates.length
  const queue = deps.candidates.slice(0, limit)
  for (const candidate of deps.candidates.slice(queue.length)) {
    skipped.push({
      candidateId: candidate.id,
      path: candidate.path,
      line: candidate.line,
      reason: `over the judge limit of ${limit} candidates`,
    })
  }

  const ctx = await createContext(deps.root, deps.scope)

  let judgedCount = 0
  for (const candidate of queue) {
    deps.onCandidate?.(judgedCount, queue.length, candidate.path)
    judgedCount += 1
    const relative = repoRelative(ctx.root, candidate.path)
    if (relative === null) {
      skipped.push({
        candidateId: candidate.id,
        path: candidate.path,
        line: candidate.line,
        reason: 'candidate path is outside the analysed root',
      })
      continue
    }

    const line =
      Number.isFinite(candidate.line) && candidate.line >= 1 ? Math.floor(candidate.line) : 1

    let slices: Slice[]
    try {
      slices = await contextSlices(ctx, relative, line)
    } catch (error) {
      skipped.push({
        candidateId: candidate.id,
        path: candidate.path,
        line: candidate.line,
        reason: `candidate file cannot be read: ${messageOf(error)}`,
      })
      continue
    }
    if (slices.length === 0) {
      skipped.push({
        candidateId: candidate.id,
        path: candidate.path,
        line: candidate.line,
        reason: 'candidate file has no readable lines',
      })
      continue
    }

    const promptCandidate: Candidate = { ...candidate, path: relative, line }
    const prompt = buildJudgePrompt(promptCandidate, slices, lang)
    const windows = shownWindows(slices)

    let accepted: LearningPoint | null = null
    let skipReason = ''
    let lastReason = ''

    for (
      let attempt = 0;
      attempt < MAX_REPLY_ATTEMPTS && accepted === null && skipReason === '';
      attempt += 1
    ) {
      const request: ModelRequest = {
        system: prompt.system,
        user:
          attempt === 0
            ? prompt.user
            : `${prompt.user}${repairNote(lang, shortReason(lastReason))}`,
        schema: POINT_SCHEMA,
      }

      let raw: unknown
      try {
        const reply = await deps.client.complete(request)
        usage.in += reply.usage.in
        usage.out += reply.usage.out
        raw = reply.json
      } catch (error) {
        if (error instanceof MissingCredentialsError) throw error
        if (error instanceof ModelReplyError) {
          usage.in += error.usage.in
          usage.out += error.usage.out
          lastReason = error.message
          continue
        }
        // The client has already spent its retry budget on a 429/5xx/network
        // failure. Another attempt here would multiply the latency, not the odds.
        if (error instanceof ModelRequestError) {
          lastReason = error.message
          if (error.detail !== '') {
            deps.onProviderError?.({ status: error.status, excerpt: error.detail })
          }
          break
        }
        lastReason = `model call failed: ${messageOf(error)}`
        break
      }

      const reply = parseReply(raw)
      if (!reply.ok) {
        lastReason = reply.reason
        continue
      }
      if (reply.value['skip'] === true) {
        skipReason = '这段代码里没有找到可迁移的决策'
        break
      }

      const shaped = parsePoint(reply.value, promptCandidate)
      if (!shaped.ok) {
        lastReason = shaped.reason
        continue
      }
      accepted = shaped.point
    }

    if (accepted !== null) {
      // A citation the prompt did not show is not evidence, even when the
      // snippet it names is really on disk: the model could not have read it.
      points.push(keepShownEvidence(accepted, windows))
      continue
    }

    // A skip is an answer; an empty `skipReason` with a reason attached is a failure.
    if (skipReason === '' && lastReason !== '') replyFailures += 1
    skipped.push({
      candidateId: candidate.id,
      path: candidate.path,
      line: candidate.line,
      reason: skipReason !== '' ? skipReason : shortReason(lastReason) || 'model produced no usable point',
    })
  }

  // Always, so no caller can return unvalidated model output by forgetting.
  const validation = await validatePoints(points, ctx.root, deps.runId, deps.scope)

  return { points: validation.kept, usage, validation, skipped, replyFailures }
}
