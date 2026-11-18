/**
 * `ana history <runId>` — where the cited code came from, from git metadata.
 *
 * The report says what a line is; history says when it last changed and under what
 * message. That is the closest this tool gets to "why", and it is deliberately kept
 * outside the evidence model: a commit message is not a byte in the tree, and
 * calling it evidence would weaken the rule that every claim resolves to `path:line`.
 *
 * It only works for a run whose source is a local checkout that still exists. A
 * GitHub source has no history here — the archive was never cloned — and the
 * command says so rather than inventing one.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { LearningPoint } from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { readManifest, readRunArtifact } from '../store/runs.js'

const run = promisify(execFile)

export const HISTORY_USAGE = `Usage: ana history <runId> [options]

Options:
  --json         Print the commit context as JSON
  --dir <path>   Look in this run directory instead of .ana/runs`

export type HistoryOptions = { baseDir?: string }
export type HistoryArgs =
  | { help: true }
  | { help: false; runId: string; json: boolean; options: HistoryOptions }

export type HistoryEntry = {
  path: string
  commit: string
  date: string
  subject: string
}

export class HistoryUsageError extends Error {}

export function parseHistoryArgs(argv: string[]): HistoryArgs {
  const positional: string[] = []
  const options: HistoryOptions = {}
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
      if (next === undefined || next.startsWith('--')) throw new HistoryUsageError('--dir needs a value')
      options.baseDir = path.resolve(next)
      index += 1
      continue
    }
    if (token.startsWith('-')) throw new HistoryUsageError(`unknown option "${token}"`)
    positional.push(token)
  }
  if (help) return { help: true }
  const [runId, ...rest] = positional
  if (runId === undefined) throw new HistoryUsageError('history needs a run id')
  if (rest.length > 0) throw new HistoryUsageError(`unexpected argument "${rest[0]}"`)
  return { help: false, runId, json, options }
}

/** The commit that last touched one path, or null when git has nothing to say. */
async function lastCommit(repo: string, file: string): Promise<HistoryEntry | null> {
  try {
    const { stdout } = await run('git', ['-C', repo, 'log', '-1', '--format=%h%x09%ad%x09%s', '--', file], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    })
    const line = stdout.trim()
    if (line === '') return null
    const [commit = '', date = '', ...subject] = line.split('\t')
    return { path: file, commit, date, subject: subject.join(' ') }
  } catch {
    return null
  }
}

/**
 * Reads the checkpoint's source and asks git about every cited path.
 *
 * Duplicate paths across points are collapsed: the question is per file, not per
 * claim. A path git cannot explain is omitted, not filled with a placeholder.
 */
export async function runHistory(
  runId: string,
  opts: HistoryOptions = {},
): Promise<{ source: string; entries: HistoryEntry[] }> {
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  const manifest = await readManifest(baseDir, runId)
  if (manifest === null) throw new HistoryUsageError(`no such run "${runId}"`)

  const source = manifest.source
  let info
  try {
    info = await stat(source)
  } catch {
    throw new HistoryUsageError(
      `run ${runId} was analysed from ${source}, which is not a local checkout any more`,
    )
  }
  if (!info.isDirectory()) {
    throw new HistoryUsageError(`run ${runId} was analysed from ${source}, not a local directory`)
  }

  const points = await readRunArtifact<LearningPoint[]>(baseDir, runId, 'points')
  if (!Array.isArray(points)) throw new HistoryUsageError(`run ${runId} has no points to follow`)

  const paths = [
    ...new Set(
      points.flatMap((point) => point.theirs.evidence.map((evidence) => evidence.path)),
    ),
  ].slice(0, 40)
  const entries: HistoryEntry[] = []
  for (const file of paths) {
    const entry = await lastCommit(source, file)
    if (entry !== null) entries.push(entry)
  }
  return { source, entries }
}

export function formatHistory(source: string, entries: HistoryEntry[]): string {
  const lines = [`source  ${source}`, '']
  if (entries.length === 0) {
    lines.push('No cited file has a commit git can name.')
    return `${lines.join('\n')}\n`
  }
  for (const entry of entries) {
    lines.push(`${entry.commit}  ${entry.date}  ${entry.path}`, `  ${entry.subject}`)
  }
  lines.push('', 'This is commit metadata, not evidence. A claim still resolves to path:line.')
  return `${lines.join('\n')}\n`
}
