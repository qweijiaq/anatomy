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

Delete one stored analysis. Runs live in .ana/runs, reconstructed applications in
.ana/apps; the same id never names both, so one command covers them.

Options:
  --app           Look in .ana/apps instead of .ana/runs
  --dir <path>    Look in this directory instead`

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

export function parseForgetArgs(argv: string[]): {
  id: string
  target: ForgetTarget
  baseDir?: string
} {
  let id: string | undefined
  let target: ForgetTarget = 'run'
  let baseDir: string | undefined

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
    if (token.startsWith('--')) throw new Error(`未知参数 ${token}`)
    if (id !== undefined) throw new Error('一次只能删一个')
    id = token
  }

  if (id === undefined) throw new Error('需要一个 run id 或应用名')
  return { id, target, ...(baseDir === undefined ? {} : { baseDir }) }
}
