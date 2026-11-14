/**
 * `ana runs`: what is stored, before you have an id to ask about.
 *
 * The window has always listed the store; the CLI never did. `ana report <id>` and
 * `ana forget <id>` both take an id, and the only way to learn one was `ls .ana/runs`
 * — digests in alphabetical order, saying nothing about which is newer, which has a
 * report, or which repository it came from.
 *
 * ## What this answers
 *
 * Three questions, in the order they are asked: is there anything here, which of
 * these can I read, and which should I delete. So each row carries the date, the
 * source, the point count, and whether a report exists — `forget --keep n` and
 * `report <id>` are then usable without opening a directory listing.
 *
 * ## What it does not do
 *
 * It reads. Nothing is stamped, repaired or reordered on disk, for the same reason
 * `report` does not: a reader that writes turns a corrupted artifact into a silent
 * fact. A run whose manifest cannot be read is listed as `unreadable` rather than
 * hidden, because a directory the tool cannot explain is exactly what someone
 * checking their store needs to see.
 */

import path from 'node:path'

import type { LearningPoint, RunManifest } from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { isArtifactName, readRunArtifact } from '../store/runs.js'

export const RUNS_USAGE = `Usage: ana runs [options]

List the stored analyses, newest first.

Options:
  --dir <path>    Look in this directory instead of .ana/runs
  --json          Print the list as JSON, for scripts`

export type StoredRun = {
  runId: string
  /** `complete` means every artifact is on disk; `unreadable` means no manifest. */
  status: 'complete' | 'failed' | 'unreadable'
  startedAt: string
  source: string
  points: number | null
  hasReport: boolean
  /** Milliseconds since the epoch of the manifest, used for ordering and aging. */
  at: number
}

export type ListRunsOptions = { baseDir?: string }

/**
 * Every stored run, newest first.
 *
 * Order comes from the manifest's mtime rather than its `startedAt`, because a run
 * that was interrupted has a start time and no completion; the file's stamp is the
 * one every directory has. Ties fall back to the id so the order is stable.
 */
export async function listRuns(options: ListRunsOptions = {}): Promise<StoredRun[]> {
  const baseDir = path.resolve(options.baseDir ?? DEFAULT_RUNS_DIR)
  const { readdir, stat } = await import('node:fs/promises')

  let entries: string[]
  try {
    entries = (await readdir(baseDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isArtifactName(entry.name))
      .map((entry) => entry.name)
  } catch {
    // No store yet is not an error: nothing has been analysed here.
    return []
  }

  const runs: StoredRun[] = []
  for (const runId of entries) {
    let at = 0
    try {
      at = (await stat(path.join(baseDir, runId, 'manifest.json'))).mtimeMs
    } catch {
      at = 0
    }

    const manifest = await readRunArtifact<RunManifest>(baseDir, runId, 'manifest')
    if (manifest === null || typeof manifest !== 'object') {
      runs.push({ runId, status: 'unreadable', startedAt: '', source: '', points: null, hasReport: false, at })
      continue
    }

    const points = await readRunArtifact<LearningPoint[]>(baseDir, runId, 'points')
    const synthesis = await readRunArtifact<{ problem?: string }>(baseDir, runId, 'synthesis')
    runs.push({
      runId,
      status: manifest.status === 'complete' ? 'complete' : 'failed',
      startedAt: typeof manifest.startedAt === 'string' ? manifest.startedAt : '',
      source: typeof manifest.source === 'string' ? manifest.source : '',
      points: Array.isArray(points) ? points.length : null,
      // The same question the window asks of its history: can I read a report here?
      hasReport: manifest.status === 'complete' && synthesis !== null && Array.isArray(points),
      at,
    })
  }

  runs.sort((a, b) => (b.at === a.at ? a.runId.localeCompare(b.runId) : b.at - a.at))
  return runs
}

/** `2026-11-14T03:12:15.943Z` → `2026-11-14 03:12`, in local time. */
function when(iso: string): string {
  if (iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One line per run, aligned; the id is last because it is the thing to copy. */
export function formatRuns(runs: StoredRun[]): string {
  if (runs.length === 0) {
    return '还没有存档分析。`ana analyze <repo>` 会写第一轮。\n'
  }
  const rows = runs.map((run) => ({
    when: when(run.startedAt),
    what: run.hasReport
      ? `${run.points ?? 0} 个点`
      : run.status === 'unreadable'
        ? '读不出 manifest'
        : run.status === 'failed'
          ? '未完成'
          : '有产物但没有报告',
    source: run.source === '' ? '—' : run.source,
    id: run.runId,
  }))
  const width = (key: 'when' | 'what'): number => Math.max(...rows.map((row) => row[key].length))
  const lines = rows.map(
    (row) => `${row.when.padEnd(width('when'))}  ${row.what.padEnd(width('what'))}  ${row.source}  ${row.id}`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * The list as data.
 *
 * `at` is a filesystem stamp and is dropped: it exists to sort, and a millisecond
 * since the epoch is not something a caller can use without also knowing which
 * clock produced it.
 */
export function runsJson(runs: StoredRun[]): string {
  return `${JSON.stringify(
    runs.map(({ at: _at, ...rest }) => rest),
    null,
    2,
  )}\n`
}

export function parseRunsArgs(argv: string[]): { help: true } | { help: false; baseDir?: string; json: boolean } {
  let baseDir: string | undefined
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') return { help: true }
    if (token === '--json') {
      json = true
      continue
    }
    if (token === '--dir') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--dir 需要一个目录')
      baseDir = value
      index += 1
      continue
    }
    throw new Error(`unknown option "${token}"`)
  }

  return { help: false, json, ...(baseDir === undefined ? {} : { baseDir }) }
}
