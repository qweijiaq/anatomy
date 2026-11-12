/**
 * The kernel pipeline: one function that turns a source reference into a run
 * directory full of artifacts, without a single model call.
 *
 * This is the assembly the product hangs everything else on. `ana scan` is the
 * first caller and the later writing layer is the second, so the order of the
 * stages exists once, here: acquire → scope → profile → structure → signals.
 * Every stage is independently tested; this module only decides *what runs in
 * which order* and *what is persisted*, and is deliberately thin so a stage
 * change cannot hide in the wiring.
 *
 * Two invariants carry the run directory:
 *
 * - `runId` is derived from (sha, ref, subpath, engine version), so a second scan
 *   of the same tree reopens the same directory instead of minting a new one.
 * - Artifacts are written before the extracted tree is closed. The tree is
 *   re-acquirable from `source` + `ref`; the artifacts are the run.
 *
 * Nothing here executes the target repository. It is walked, hashed, read and
 * indexed — never installed, built or run.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  Candidate,
  Profile,
  RunManifest,
  Scope,
  StructureIndex,
} from '../contracts/types.js'
import { readVersion } from '../version.js'
import { closeRun, openRun, type Run } from '../store/runs.js'
import {
  deriveRunId,
  downloadArchive,
  extractTarSafe,
  resolveSource,
  type AcquireDeps,
  type ResolvedSource,
} from './acquire.js'
import { profileRepo } from './profile.js'
import { selectScope } from './scope.js'
import { collectSignals } from './signals.js'
import { indexPython, indexTypeScript, mergeIndexes } from './structure/index.js'

/** Where runs land when the caller names no directory: `<cwd>/.ana/runs`. */
export const DEFAULT_RUNS_DIR = path.join('.ana', 'runs')

export type PipelineOptions = {
  /** Analyse only this subdirectory of the repository. Defaults to the source's own. */
  subpath?: string
  /** Tag, branch or commit to analyse. Resolved by `resolveSource`. */
  ref?: string
  /** How many candidates to keep. Defaults to `DEFAULT_TOP_K`. */
  topK?: number
  /** Run directory parent. Defaults to `<cwd>/.ana/runs`. */
  baseDir?: string
  /** Injected acquisition dependencies, so tests never touch the network. */
  deps?: AcquireDeps
}

export type PipelineResult = {
  runId: string
  run: Run
  scope: Scope
  profile: Profile
  structure: StructureIndex
  candidates: Candidate[]
}

/**
 * Downloads an archive source into a throwaway directory.
 *
 * The archive bytes have to exist somewhere before extraction, and that somewhere
 * must not be the run directory: the run holds what was produced from the tree,
 * not the tree. The directory is the caller's to remove.
 */
async function fetchArchive(
  source: ResolvedSource,
  deps: AcquireDeps,
): Promise<{ dir: string; file: string; sha: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'anatomy-acquire-'))
  const file = path.join(dir, 'source.tar.gz')
  try {
    const { sha } = await downloadArchive(source, file, deps)
    return { dir, file, sha }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/** Strips the leading/trailing slashes a user or a URL may have left on a subpath. */
const cleanSubpath = (subpath: string): string => subpath.replace(/^\/+|\/+$/g, '')

/**
 * Runs the whole deterministic kernel over `input` and persists the result.
 *
 * `root` is always the repository root, even when a `subpath` narrows the scope:
 * scope paths are repository-relative, and both `profileRepo` and `collectSignals`
 * are handed the same root so those paths resolve to the same files.
 */
export async function scanRepo(
  input: string,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const deps = opts.deps ?? {}
  const source = await resolveSource(input, opts.ref === undefined ? {} : { ref: opts.ref }, deps)
  const subpath = cleanSubpath(opts.subpath ?? source.subpath)
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  const engineVersion = readVersion()

  let archive: { dir: string; file: string; sha: string } | null = null
  try {
    if (source.kind === 'archive') archive = await fetchArchive(source, deps)
    // `source.sha` is empty for archives by design: the digest is only knowable
    // once the bytes have arrived.
    const sha = archive === null ? source.sha : archive.sha

    const runId = deriveRunId({ sha, ref: source.ref, subpath, engineVersion })
    const manifest: RunManifest = {
      runId,
      source: input,
      ref: source.ref,
      sha,
      subpath,
      engineVersion,
      startedAt: new Date().toISOString(),
    }
    const run = await openRun(baseDir, manifest)

    try {
      const root = await materialize(run, source, archive)
      const scope = await selectScope(root, subpath === '' ? {} : { subpath })
      const profile = await profileRepo(root, scope)
      // One language family per pass, merged afterwards: a polyglot tree has no
      // shared compilation to hang a single index on.
      const structure = mergeIndexes([
        await indexTypeScript(root, scope),
        await indexPython(root, scope),
      ])
      const candidates = await collectSignals(
        root,
        scope,
        structure,
        opts.topK === undefined ? {} : { topK: opts.topK },
      )

      await run.write('profile', profile)
      await run.write('structure', structure)
      await run.write('candidates', candidates)

      return { runId, run, scope, profile, structure, candidates }
    } finally {
      // The tree is a means to the artifacts, and it is re-acquirable from
      // `source` + `ref`. `closeRun` removes only `tree/`, never an artifact.
      await closeRun(run)
    }
  } finally {
    if (archive !== null) await rm(archive.dir, { recursive: true, force: true })
  }
}

/**
 * The repository root on disk for this run.
 *
 * A local source is read in place — copying the user's checkout into a run
 * directory would be a surprise, and `resolveSource` already digested it. An
 * archive is extracted into `tree/`, which must be empty: leftovers from an
 * interrupted earlier attempt would mix two trees into one analysis.
 */
async function materialize(
  run: Run,
  source: ResolvedSource,
  archive: { dir: string; file: string } | null,
): Promise<string> {
  if (archive === null) {
    if (source.path === undefined) {
      throw new Error('anatomy: local source has no directory to read')
    }
    return source.path
  }
  await rm(run.treeDir, { recursive: true, force: true })
  await extractTarSafe(archive.file, run.treeDir)
  return run.treeDir
}
