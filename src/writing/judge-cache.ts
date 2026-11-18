/**
 * Reusing judged candidates when the tree has not changed.
 *
 * A second analysis of the same commit used to pay for every candidate again. The
 * identity of a tree is its sha, so the cache key is (sha, model, language, prompt
 * version) — not a file path and not a timestamp. A changed tree, a different model
 * or an edited judge prompt all miss, which is the point: a cache that cannot say
 * why it is valid is a place for stale claims to hide.
 *
 * What is stored is the same pre-validation checkpoint `resume` uses. Reused points
 * go through `validatePoints` again against the re-acquired tree, so the cache can
 * save money but cannot save a claim from being checked.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { JudgeProgress, JudgeResume } from './judge.js'

/**
 * Bump this whenever the judge prompt, schema or evidence rules change.
 *
 * It is deliberately a manual number: the prompt is code, and a hash of the
 * bundled string would change with formatting but not with a rule buried in a
 * helper. A reviewer seeing a prompt edit is the moment to bump it.
 */
export const JUDGE_PROMPT_VERSION = 1

export type CacheKeyInput = {
  sha: string
  model: string
  lang: string
}

/** A stable, filesystem-safe key. Empty sha means "do not cache". */
export function judgeCacheKey(input: CacheKeyInput): string {
  if (input.sha === '') return ''
  return createHash('sha256')
    .update(`${JUDGE_PROMPT_VERSION}\n${input.sha}\n${input.model}\n${input.lang}`)
    .digest('hex')
}

/** `<baseDir>/.cache` — beside the runs, and skipped by `listRuns` like any dotted name. */
export function judgeCacheDir(baseDir: string): string {
  return path.join(path.resolve(baseDir), '.cache')
}

function isResume(value: unknown): value is JudgeResume {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    Array.isArray(record['done']) &&
    Array.isArray(record['points']) &&
    Array.isArray(record['skipped']) &&
    typeof record['replyFailures'] === 'number'
  )
}

/**
 * The cached checkpoint, or null.
 *
 * A malformed cache is ignored, not repaired and not surfaced: it is an
 * optimisation, and the honest fallback is to judge again.
 */
export async function readJudgeCache(dir: string, key: string): Promise<JudgeResume | null> {
  if (key === '') return null
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, `${key}.json`), 'utf8'))
    if (!isResume(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** Best-effort: a cache write that fails must not fail the analysis. */
export async function writeJudgeCache(
  dir: string,
  key: string,
  progress: JudgeProgress,
): Promise<void> {
  if (key === '') return
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${key}.json`), `${JSON.stringify(progress)}\n`, 'utf8')
  } catch {
    // A read-only store is a slower run, not a broken one.
  }
}
