/**
 * Deleting a stored analysis.
 *
 * Every run and every reconstructed application leaves a directory behind, and
 * until now nothing in the tool could remove one. `.ana/runs` and `.ana/apps` only
 * grew: a person who analyses twenty repositories while learning the tool keeps
 * twenty of them, including the ten that were wrong.
 *
 * ## What this refuses to do
 *
 * It takes an id, never a path. The id is resolved under a known base directory and
 * has to look like an artifact name — no separators, no `..`, no absolute paths —
 * so a typo cannot become `rm -rf` somewhere else. `isArtifactName` is the same
 * check the store already uses before reading, which means an id that cannot be
 * read is also an id that cannot be deleted, and the two agree by construction.
 */

import { rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { isArtifactName } from '../store/runs.js'

export const FORGET_USAGE = `Usage: ana forget <runId|app-name> [options]
       ana forget --keep <n> [--dir <path>]

Delete one stored analysis. Runs live in .ana/runs, reconstructed applications in
.ana/apps; the same id never names both, so one command covers them.

Options:
  --app           Look in .ana/apps instead of .ana/runs
  --dir <path>    Look in this directory instead
  --keep <n>      Keep the n most recent runs and delete the rest. No id is given;
                  at least one is kept, because "delete everything" should take one
                  deliberate step per run rather than one flag`

export type ForgetTarget = 'run' | 'app'

export type ForgetResult = { removed: string } | { missing: true }

/**
 * Delete `id` under the chosen base directory.
 *
 * Returns rather than throws for "not there": a delete that is already done is not
 * a failure, and a script that says `forget` twice should not exit non-zero the
 * second time for having succeeded the first.
 */
export async function forget(
  id: string,
  options: { target?: ForgetTarget; baseDir?: string } = {},
): Promise<ForgetResult> {
  if (!isArtifactName(id)) {
    throw new Error(`"${id}" 不像是 run id 或应用名：它不能包含路径分隔符或 ..`)
  }
  const target = options.target ?? 'run'
  const dir = path.resolve(
    options.baseDir ?? (target === 'app' ? path.join('.ana', 'apps') : DEFAULT_RUNS_DIR),
  )
  const absolute = path.join(dir, id)

  // Belt and braces: the id is already checked, and this refuses anyway if the
  // resolved path escaped the directory it was supposed to be under.
  if (path.dirname(absolute) !== dir) {
    throw new Error(`拒绝删除 ${absolute}：它不在 ${dir} 下`)
  }

  // Two separate questions. `stat` failing means nothing is there, which is not an
  // error. Something being there and not being a directory is a different answer and
  // must not be swallowed by the same catch — an early version did, and turned
  // "refuse to delete a file" into "report it missing".
  let exists = true
  try {
    await stat(absolute)
  } catch {
    exists = false
  }
  if (!exists) return { missing: true }

  const info = await stat(absolute)
  if (!info.isDirectory()) throw new Error(`${absolute} 不是目录`)

  await rm(absolute, { recursive: true, force: true })
  return { removed: absolute }
}

/**
 * Keep the `keep` most recent runs under `baseDir` and delete the rest.
 *
 * Runs are ordered by the mtime of their `manifest.json`, which is written once when
 * a run finishes — the directory's own mtime moves whenever anything inside it does,
 * and a run id is a digest whose name carries no time. A run with no readable
 * manifest sorts last, so it is the first to go.
 *
 * Returns the paths actually removed, newest-kept first, so the caller can print
 * exactly what happened instead of a count.
 */
export async function keepRecent(
  keep: number,
  options: { baseDir?: string } = {},
): Promise<{ removed: string[]; kept: string[] }> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep 至少是 1（要全删就逐个 forget）：收到 ${String(keep)}`)
  }
  const dir = path.resolve(options.baseDir ?? DEFAULT_RUNS_DIR)
  let entries: string[]
  try {
    const { readdir } = await import('node:fs/promises')
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isArtifactName(entry.name))
      .map((entry) => entry.name)
  } catch {
    return { removed: [], kept: [] }
  }

  const stamped: Array<{ id: string; at: number }> = []
  for (const id of entries) {
    let at = -1
    try {
      at = (await stat(path.join(dir, id, 'manifest.json'))).mtimeMs
    } catch {
      // No manifest: an interrupted run. It still sorts, at the oldest end.
    }
    stamped.push({ id, at })
  }
  stamped.sort((a, b) => b.at - a.at)

  const kept = stamped.slice(0, keep).map((entry) => path.join(dir, entry.id))
  const removed: string[] = []
  for (const entry of stamped.slice(keep)) {
    const absolute = path.join(dir, entry.id)
    await rm(absolute, { recursive: true, force: true })
    removed.push(absolute)
  }
  return { removed, kept }
}

export type ForgetArgs =
  | { mode: 'one'; id: string; target: ForgetTarget; baseDir?: string }
  | { mode: 'keep'; keep: number; baseDir?: string }

export function parseForgetArgs(argv: string[]): ForgetArgs {
  let id: string | undefined
  let target: ForgetTarget = 'run'
  let baseDir: string | undefined
  let keep: number | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--app') {
      target = 'app'
      continue
    }
    if (token === '--dir') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--dir 需要一个目录')
      baseDir = value
      index += 1
      continue
    }
    if (token === '--keep') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--keep 需要一个数字')
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--keep 至少是 1（要全删就逐个 forget）：收到 ${value}`)
      }
      keep = parsed
      index += 1
      continue
    }
    if (token.startsWith('--')) throw new Error(`未知参数 ${token}`)
    if (id !== undefined) throw new Error('一次只能删一个')
    id = token
  }

  if (keep !== undefined) {
    if (id !== undefined) throw new Error('--keep 不接受 id：它自己决定删哪些')
    if (target === 'app') throw new Error('--keep 只作用于 run；应用目录请逐个 forget --app')
    return { mode: 'keep', keep, ...(baseDir === undefined ? {} : { baseDir }) }
  }

  if (id === undefined) throw new Error('需要一个 run id 或应用名')
  return { mode: 'one', id, target, ...(baseDir === undefined ? {} : { baseDir }) }
}
