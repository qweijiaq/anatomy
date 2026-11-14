/**
 * `ana inspect <evidenceId>`: the citation, on demand.
 *
 * A report is a set of claims, and every claim carries an id — `runId` plus a
 * short digest of `path` and the first line — precisely so a reader who doubts
 * one line can ask for it without scrolling the page. The extracted tree is gone
 * by then, so the answer comes from the stored points: the range the run cited
 * and the snippet it kept.
 *
 * The lookup walks every run under the parent instead of "the newest one",
 * because ids are self-describing: an id from last week's report must still
 * resolve. A run whose `points.json` is missing or unreadable is skipped rather
 * than fatal — one broken directory must not hide the evidence in the next one.
 */

import path from 'node:path'

import type { Evidence, LearningPoint } from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { isArtifactName, readRunArtifact } from '../store/runs.js'

export const INSPECT_USAGE = `Usage: ana inspect <evidenceId | path:start-end>

The id — \`<runId>-<digest>\` — is the stable name; the location is what the report
prints, so either one works: \`ana inspect lib/store.mjs:7-8\`.`

export type InspectOptions = {
  /** Run directory parent. Defaults to `<cwd>/.ana/runs`. */
  baseDir?: string
  /** Print target, alongside the returned text. */
  out?: { write(chunk: string): unknown }
}

export type InspectArgs = { help: true } | { help: false; evidenceId: string }

/** Where one evidence id was found: the run, and the evidence as stored. */
export type EvidenceHit = { runId: string; evidence: Evidence }

/** A misuse of the command line: reported with the usage line, never with a stack. */
export class InspectUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InspectUsageError'
  }
}

/**
 * `path:start-end`, the form the report prints.
 *
 * The id is a digest — `0c1cd4e7b0ec-3476f2` — and no page shows it, so the only
 * thing a reader can copy off the report is the location. Accepting both is what
 * makes the command reachable from the artifact it exists to verify: without this,
 * `ana inspect lib/store.mjs:7-8` answered "no such evidence", which is true and
 * useless — the reader had the right line and the wrong spelling.
 */
const LOCATION = /^(.+):(\d+)-(\d+)$/

/** A `path:start-end` reference, or `null` when the argument is an id. */
export function asLocation(evidenceId: string): { path: string; startLine: number; endLine: number } | null {
  const match = LOCATION.exec(evidenceId)
  if (match === null) return null
  const startLine = Number(match[2])
  const endLine = Number(match[3])
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null
  if (startLine < 1 || endLine < startLine) return null
  return { path: match[1] as string, startLine, endLine }
}

/** The id is in no stored point of any run. */
export class NoSuchEvidenceError extends Error {
  constructor(evidenceId: string, baseDir: string) {
    const hint = asLocation(evidenceId) === null ? '' : ' (a location was given; no run cites it)'
    super(`anatomy: no such evidence "${evidenceId}"${hint} in ${baseDir}`)
    this.name = 'NoSuchEvidenceError'
  }
}

/** Parses `inspect` arguments: exactly one evidence id, and `--help`. */
export function parseInspectArgs(argv: string[]): InspectArgs {
  const positional: string[] = []

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg !== '-' && arg.startsWith('-')) {
      throw new InspectUsageError(`unknown option "${arg}"`)
    }
    positional.push(arg)
  }

  if (positional.length === 0) throw new InspectUsageError('inspect needs an evidence id or a path:start-end')
  if (positional.length > 1) {
    throw new InspectUsageError(`inspect takes one evidence id, got ${positional.length}`)
  }
  return { help: false, evidenceId: positional[0] as string }
}

/**
 * `path:startLine-endLine` and then the snippet, byte for byte.
 *
 * The citation is the same form the report prints, so a reader can diff what the
 * page showed against what the run stored; the snippet is not re-indented or
 * re-wrapped, because the point of the command is to see exactly those bytes.
 */
export function formatEvidence(evidence: Evidence): string {
  const text = `${evidence.path}:${evidence.startLine}-${evidence.endLine}\n${evidence.snippet}`
  return text.endsWith('\n') ? text : `${text}\n`
}

function isEvidence(value: unknown): value is Evidence {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Evidence>
  return (
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.path === 'string' &&
    candidate.path !== '' &&
    typeof candidate.startLine === 'number' &&
    typeof candidate.endLine === 'number' &&
    typeof candidate.snippet === 'string' &&
    candidate.snippet !== ''
  )
}

/** The stored points of one run, or `[]` when the directory holds none we can read. */
async function pointsOf(baseDir: string, runId: string): Promise<LearningPoint[]> {
  const points = await readRunArtifact<LearningPoint[]>(baseDir, runId, 'points')
  return Array.isArray(points) ? points : []
}

/**
 * The first stored evidence whose id is `evidenceId`, searching every run under
 * the parent.
 */
export async function findEvidence(
  evidenceId: string,
  opts: InspectOptions = {},
): Promise<EvidenceHit> {
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  let entries: string[]
  try {
    const { readdir } = await import('node:fs/promises')
    entries = (await readdir(baseDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isArtifactName(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    // A parent that does not exist holds no evidence either; the answer is the
    // same, and the message names the directory that was searched.
    throw new NoSuchEvidenceError(evidenceId, baseDir)
  }

  const all: Array<{ runId: string; evidence: Evidence }> = []
  for (const runId of entries) {
    for (const point of await pointsOf(baseDir, runId)) {
      const evidence = (point as LearningPoint | undefined)?.theirs?.evidence
      if (!Array.isArray(evidence)) continue
      for (const item of evidence) {
        if (!isEvidence(item)) continue
        if (item.id === evidenceId) return { runId, evidence: item }
        all.push({ runId, evidence: item })
      }
    }
  }

  // Not an id — so try the form the report actually prints. More than one run may
  // cite the same range, and run ids are digests, so their order says nothing about
  // time; the answer that helps is the most recent run, which is the one whose
  // report the reader is most likely holding. Ordered by mtime, first match wins.
  const location = asLocation(evidenceId)
  if (location !== null) {
    const matches = all.filter(
      (hit) =>
        hit.evidence.path === location.path &&
        hit.evidence.startLine === location.startLine &&
        hit.evidence.endLine === location.endLine,
    )
    if (matches.length > 0) {
      const order = await newestFirst(baseDir, matches)
      return order[0] as { runId: string; evidence: Evidence }
    }
  }

  throw new NoSuchEvidenceError(evidenceId, baseDir)
}

/**
 * The same matches, ordered by how recently their run was written.
 *
 * `manifest.json` is written once when a run finishes, so its mtime is the run's
 * age. A run whose manifest cannot be stated sorts last rather than failing: one
 * unreadable directory must not hide evidence that is otherwise found.
 */
async function newestFirst(
  baseDir: string,
  matches: Array<{ runId: string; evidence: Evidence }>,
): Promise<Array<{ runId: string; evidence: Evidence }>> {
  const { stat } = await import('node:fs/promises')
  const stamps = new Map<string, number>()
  for (const hit of matches) {
    if (stamps.has(hit.runId)) continue
    try {
      const info = await stat(path.join(baseDir, hit.runId, 'manifest.json'))
      stamps.set(hit.runId, info.mtimeMs)
    } catch {
      stamps.set(hit.runId, -1)
    }
  }
  return [...matches].sort((a, b) => (stamps.get(b.runId) ?? -1) - (stamps.get(a.runId) ?? -1))
}

/** Finds the evidence and, when a writer was given, prints it. */
export async function runInspect(
  evidenceId: string,
  opts: InspectOptions = {},
): Promise<string> {
  const { evidence } = await findEvidence(evidenceId, opts)
  const text = formatEvidence(evidence)
  opts.out?.write(text)
  return text
}
