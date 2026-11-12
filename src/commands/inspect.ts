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

export const INSPECT_USAGE = 'Usage: ana inspect <evidenceId>'

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

/** The id is in no stored point of any run. */
export class NoSuchEvidenceError extends Error {
  constructor(evidenceId: string, baseDir: string) {
    super(`anatomy: no such evidence "${evidenceId}" in ${baseDir}`)
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

  if (positional.length === 0) throw new InspectUsageError('inspect needs an evidence id')
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

  for (const runId of entries) {
    for (const point of await pointsOf(baseDir, runId)) {
      const evidence = (point as LearningPoint | undefined)?.theirs?.evidence
      if (!Array.isArray(evidence)) continue
      for (const item of evidence) {
        if (isEvidence(item) && item.id === evidenceId) return { runId, evidence: item }
      }
    }
  }

  throw new NoSuchEvidenceError(evidenceId, baseDir)
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
