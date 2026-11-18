/**
 * `ana diff <before> <after>` — two source analyses, compared as facts.
 *
 * The window has shown this since the first batch; the CLI is what a script or a
 * pull-request job can call. It reads only artifacts and never re-analyses, and it
 * prints the same numbers `diffRuns` computes for the window — one implementation,
 * two entrances.
 */

import path from 'node:path'

import type {
  Candidate,
  LearningPoint,
  Scope,
  ValidationResult,
} from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { isArtifactName, readManifest, readRunArtifact } from '../store/runs.js'
import { diffRuns, isEmptyRunDiff, summarizeRun, type RunDiff, type RunSide } from '../app/run-diff.js'

export const DIFF_USAGE = `Usage: ana diff <beforeRunId> <afterRunId> [options]

Options:
  --json         Print the comparison as JSON
  --dir <path>   Look in this run directory instead of .ana/runs`

export type DiffOptions = { baseDir?: string }
export type DiffArgs =
  | { help: true }
  | { help: false; before: string; after: string; json: boolean; options: DiffOptions }

export class DiffUsageError extends Error {}

export function parseDiffArgs(argv: string[]): DiffArgs {
  const positional: string[] = []
  const options: DiffOptions = {}
  let json = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token === '--json') {
      json = true
      continue
    }
    if (token === '--dir') {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new DiffUsageError('--dir needs a value')
      options.baseDir = path.resolve(next)
      index += 1
      continue
    }
    if (token.startsWith('-')) throw new DiffUsageError(`unknown option "${token}"`)
    positional.push(token)
  }

  if (help) return { help: true }
  const [before, after, ...rest] = positional
  if (before === undefined || after === undefined) {
    throw new DiffUsageError('diff needs two run ids')
  }
  if (rest.length > 0) throw new DiffUsageError(`unexpected argument "${rest[0]}"`)
  return { help: false, before, after, json, options }
}

async function loadSide(baseDir: string, runId: string): Promise<RunSide> {
  if (!isArtifactName(runId)) throw new DiffUsageError(`"${runId}" is not a run id`)
  const manifest = await readManifest(baseDir, runId)
  if (manifest === null) throw new DiffUsageError(`no such run "${runId}"`)
  const [points, validation, scope, candidates] = await Promise.all([
    readRunArtifact<LearningPoint[]>(baseDir, runId, 'points'),
    readRunArtifact<ValidationResult>(baseDir, runId, 'validation'),
    readRunArtifact<Scope>(baseDir, runId, 'scope'),
    readRunArtifact<Candidate[]>(baseDir, runId, 'candidates'),
  ])
  if (!Array.isArray(points) || scope === null) {
    throw new DiffUsageError(`run "${runId}" has no report to compare`)
  }
  return summarizeRun(runId, {
    manifest,
    points,
    validation,
    scope,
    candidates: Array.isArray(candidates) ? candidates : [],
  })
}

export async function runDiff(
  before: string,
  after: string,
  opts: DiffOptions = {},
): Promise<RunDiff> {
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  const [left, right] = await Promise.all([loadSide(baseDir, before), loadSide(baseDir, after)])
  return diffRuns(left, right)
}

function signed(before: number, after: number, format: 'count' | 'percent'): string {
  const diff = after - before
  if (diff === 0) return 'no change'
  const sign = diff > 0 ? '+' : ''
  return format === 'percent' ? `${sign}${(diff * 100).toFixed(1)}pp` : `${sign}${diff}`
}

/** A terminal rendering; JSON is the machine one. */
export function formatDiff(diff: RunDiff): string {
  const lines: string[] = [
    `before  ${diff.before.source} @ ${diff.before.sha.slice(0, 7) || '—'}  ${diff.before.runId}`,
    `after   ${diff.after.source} @ ${diff.after.sha.slice(0, 7) || '—'}  ${diff.after.runId}`,
    '',
  ]
  for (const warning of diff.warnings) lines.push(`warning: ${warning}`, '')
  for (const row of diff.counters) {
    const before = row.format === 'percent' ? (row.before < 0 ? '—' : `${(row.before * 100).toFixed(1)}%`) : String(row.before)
    const after = row.format === 'percent' ? (row.after < 0 ? '—' : `${(row.after * 100).toFixed(1)}%`) : String(row.after)
    lines.push(`${row.label.padEnd(12)} ${before} -> ${after} (${signed(row.before, row.after, row.format)})`)
  }
  if (diff.addedTitles.length > 0) {
    lines.push('', 'new points:')
    for (const title of diff.addedTitles) lines.push(`  + ${title}`)
  }
  if (diff.removedTitles.length > 0) {
    lines.push('', 'points no longer present:')
    for (const title of diff.removedTitles) lines.push(`  - ${title}`)
  }
  if (isEmptyRunDiff(diff)) lines.push('', 'The two runs describe the same tree and the same numbers.')
  return `${lines.join('\n')}\n`
}
