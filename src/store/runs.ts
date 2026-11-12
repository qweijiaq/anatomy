/**
 * Run directories: the on-disk record of one analysis.
 *
 * Layout, under `<baseDir>/<runId>/`:
 *
 *   manifest.json   what was analysed (source, ref, sha, subpath, engine)
 *   tree/           the extracted repository, deleted by `closeRun`
 *   <artifact>.json every other artifact the pipeline produces
 *
 * Artifacts are written atomically (temp file + rename) because a half-written
 * JSON file makes a run unreadable and un-resumable, and `analyze` may be
 * interrupted. `tree/` is deleted by default at the end of a run: the bytes are
 * re-acquirable from `source`+`ref`, and a `node_modules`-sized tree per run is
 * not worth keeping. Artifacts are never deleted — that is the run.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { RunManifest } from '../contracts/types.js'

export type Run = {
  /** `<baseDir>/<runId>` */
  dir: string
  /** `<dir>/tree` — where extracted sources live. */
  treeDir: string
  write(name: string, value: unknown): Promise<void>
  /** `null` when the artifact does not exist; throws when it is not valid JSON. */
  read<T>(name: string): Promise<T | null>
}

/**
 * Artifact names are single path segments. Everything that could address a
 * different directory (`..`, a slash, an absolute path, a leading dot) is
 * refused, so a caller cannot write outside its own run.
 */
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function artifactPath(dir: string, name: string): string {
  if (!ARTIFACT_NAME.test(name)) {
    throw new Error(`anatomy: invalid artifact name "${name}"`)
  }
  return path.join(dir, `${name}.json`)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Creates (or reopens) the run directory and stamps the manifest. Calling it
 * twice for the same manifest is harmless and keeps existing artifacts.
 */
export async function openRun(baseDir: string, manifest: RunManifest): Promise<Run> {
  if (!ARTIFACT_NAME.test(manifest.runId)) {
    throw new Error(`anatomy: invalid runId "${manifest.runId}"`)
  }
  const dir = path.join(path.resolve(baseDir), manifest.runId)
  const treeDir = path.join(dir, 'tree')
  await mkdir(treeDir, { recursive: true })

  const run: Run = {
    dir,
    treeDir,
    async write(name: string, value: unknown): Promise<void> {
      const target = artifactPath(dir, name)
      const text = JSON.stringify(value, null, 2)
      if (text === undefined) {
        throw new Error(`anatomy: artifact "${name}" is not JSON-serialisable`)
      }
      const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
      try {
        await writeFile(temporary, `${text}\n`, 'utf8')
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
    async read<T>(name: string): Promise<T | null> {
      const target = artifactPath(dir, name)
      let text: string
      try {
        text = await readFile(target, 'utf8')
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
      try {
        return JSON.parse(text) as T
      } catch {
        throw new Error(`anatomy: artifact "${name}" in ${dir} is not valid JSON`)
      }
    },
  }

  await run.write('manifest', manifest)
  return run
}

/** End of a run: drop the extracted tree unless asked to keep it. */
export async function closeRun(run: Run, opts: { keepTree?: boolean } = {}): Promise<void> {
  if (opts.keepTree === true) return
  await rm(run.treeDir, { recursive: true, force: true })
}
