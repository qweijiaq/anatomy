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

/**
 * Whether `value` can be one path segment of a run directory.
 *
 * Exported because a reader that must not *open* a run (opening stamps the
 * manifest) still has to reject a traversal attempt as "no such run" rather than
 * as a crash from somewhere deeper.
 */
export function isArtifactName(value: string): boolean {
  return ARTIFACT_NAME.test(value)
}

function artifactPath(dir: string, name: string): string {
  if (!isArtifactName(name)) {
    throw new Error(`anatomy: invalid artifact name "${name}"`)
  }
  return path.join(dir, `${name}.json`)
}

/**
 * A `JSON.stringify` replacer that refuses `NaN`/`±Infinity` instead of letting
 * JSON turn them into `null`: a persisted `null` score reads back as "the
 * pipeline produced nothing", which is a different and undetectable fact.
 */
function nonFiniteNumbers(name: string): (key: string, value: unknown) => unknown {
  return (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(
        `anatomy: artifact "${name}" is not JSON-serialisable ` +
          `(non-finite number at "${key}": ${String(value)})`,
      )
    }
    return value
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Reads one artifact of a run directory, or `null` when it is absent. Throws
 * when it is present but not JSON.
 */
async function readArtifact<T>(dir: string, name: string): Promise<T | null> {
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
}

/** The run directory `runId` resolves to under `baseDir`. */
function runDirFor(baseDir: string, runId: string): string {
  if (!isArtifactName(runId)) {
    throw new Error(`anatomy: invalid runId "${runId}"`)
  }
  return path.join(path.resolve(baseDir), runId)
}

/**
 * One artifact of a run that may not be open, or `null` when the run or the
 * artifact is absent. Reads only: a renderer must not change what it renders.
 */
export async function readRunArtifact<T>(
  baseDir: string,
  runId: string,
  name: string,
): Promise<T | null> {
  return readArtifact<T>(runDirFor(baseDir, runId), name)
}

/**
 * The manifest already on disk for `runId`, or `null` if the run never opened.
 *
 * Exists so a caller can look at what a run directory held *before* `openRun`
 * stamps over the manifest of the directory it reopens.
 */
export async function readManifest(
  baseDir: string,
  runId: string,
): Promise<RunManifest | null> {
  return readArtifact<RunManifest>(runDirFor(baseDir, runId), 'manifest')
}

/**
 * Creates (or reopens) the run directory and stamps the manifest. Calling it
 * twice for the same manifest is harmless and keeps existing artifacts.
 */
export async function openRun(baseDir: string, manifest: RunManifest): Promise<Run> {
  const dir = runDirFor(baseDir, manifest.runId)
  const treeDir = path.join(dir, 'tree')
  await mkdir(treeDir, { recursive: true })

  const run: Run = {
    dir,
    treeDir,
    async write(name: string, value: unknown): Promise<void> {
      const target = artifactPath(dir, name)
      const text = JSON.stringify(value, nonFiniteNumbers(name), 2)
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
      return readArtifact<T>(dir, name)
    },
  }

  await run.write('manifest', manifest)
  return run
}

/** End of a run: drop the extracted tree unless asked to keep it. */
export async function closeRun(run: Run, opts: { keepTree?: boolean } = {}): Promise<void> {
  if (opts.keepTree === true) return
  const expected = path.join(path.resolve(run.dir), 'tree')
  if (path.resolve(run.treeDir) !== expected) {
    throw new Error(
      `anatomy: refusing to delete "${run.treeDir}"; only "${expected}" belongs to this run`,
    )
  }
  await rm(run.treeDir, { recursive: true, force: true })
}
