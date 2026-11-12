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
import { closeRun, openRun, readManifest, type Run } from '../store/runs.js'
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

/**
 * Every artifact a finished run owns. `manifest` is not in the list: it is
 * stamped at open and again at settle, so it cannot testify about the files
 * beside it.
 */
const RUN_ARTIFACTS = ['scope', 'profile', 'structure', 'candidates'] as const

export type PipelineOptions = {
  /** Analyse only this subdirectory of the repository. Defaults to the source's own. */
  subpath?: string
  /** Tag, branch or commit to analyse. Resolved by `resolveSource`. */
  ref?: string
  /** How many candidates to keep. Defaults to `DEFAULT_TOP_K`. */
  topK?: number
  /** Run directory parent. Defaults to `<cwd>/.ana/runs`. */
  baseDir?: string
  /**
   * Keep the extracted tree instead of deleting it when the run ends. The tree
   * is the only place a later stage can slice evidence out of, and re-acquiring
   * an archive means downloading it again.
   */
  keepTree?: boolean
  /** Injected acquisition dependencies, so tests never touch the network. */
  deps?: AcquireDeps
}

export type PipelineResult = {
  runId: string
  run: Run
  /**
   * The repository root the stages read. For a local source this is the user's
   * own directory; for an archive it is `<run>/tree`, which only survives the
   * call when `keepTree` was set.
   */
  root: string
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
    // Read what this directory held *before* it is stamped over: a re-scan that
    // fails must not erase the record of an earlier run that finished.
    const previous = await readManifest(baseDir, runId)
    const manifest: RunManifest = {
      runId,
      source: input,
      ref: source.ref,
      sha,
      subpath,
      engineVersion,
      startedAt: new Date().toISOString(),
      // Nothing is complete until the last artifact lands; see `settleFailure`.
      status: 'failed',
    }
    const run = await openRun(baseDir, manifest)
    // What this scan has already replaced in the directory. A failure part-way
    // through leaves a directory that is part this scan and part the previous
    // one, and no manifest can honestly describe that. See `settleFailure`.
    const written = new Set<string>()

    let result: PipelineResult | undefined
    let failure: unknown
    try {
      const root = await materialize(run, source, archive)
      const scope = await selectScope(root, subpath === '' ? {} : { subpath })
      const profile = await profileRepo(root, scope)
      // One language family per pass, merged afterwards: a polyglot tree has no
      // shared compilation to hang a single index on. The two walks are
      // independent, so they run at once rather than paying the Python
      // interpreter start after the whole TypeScript walk.
      const [typescript, python] = await Promise.all([
        indexTypeScript(root, scope),
        indexPython(root, scope),
      ])
      const structure = mergeIndexes([typescript, python])
      const candidates = await collectSignals(
        root,
        scope,
        structure,
        opts.topK === undefined ? {} : { topK: opts.topK },
      )

      const write = async (name: string, value: unknown): Promise<void> => {
        await run.write(name, value)
        written.add(name)
      }

      // `scope` leads the list because it is the one artifact that cannot be
      // recomputed once the tree is gone: a later report renders from here.
      await write('scope', scope)
      await write('profile', profile)
      await write('structure', structure)
      await write('candidates', candidates)
      await run.write('manifest', {
        ...manifest,
        status: 'complete',
        completedAt: new Date().toISOString(),
      })

      result = { runId, run, root, scope, profile, structure, candidates }
    } catch (error) {
      failure = error
    }

    // Settle the tree before surfacing anything: the caller may be handed `root`
    // and must not be handed a directory that is about to disappear.
    const cleanup = await closeSafely(run, opts.keepTree === true)

    if (failure !== undefined) throw await settleFailure(run, manifest, previous, written, failure)
    if (cleanup !== null) throw cleanup
    if (result === undefined) throw new Error(`anatomy: run ${runId} ended without a result`)
    return result
  } finally {
    if (archive !== null) await rm(archive.dir, { recursive: true, force: true })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ends the run: drops the extracted tree unless `keepTree` was asked for.
 *
 * Returns the failure instead of throwing it. At this point a stage error may
 * already be in flight, and a `finally` that throws would replace it; wrapping
 * keeps the cleanup cause (`EPERM`, `EBUSY`) visible when there is nothing else
 * to report.
 */
async function closeSafely(run: Run, keepTree: boolean): Promise<Error | null> {
  try {
    await closeRun(run, keepTree ? { keepTree: true } : {})
    return null
  } catch (error) {
    return new Error(
      `anatomy: could not clean up run ${path.basename(run.dir)}: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/**
 * Records what a failed scan leaves behind, and returns the error to throw.
 *
 * The manifest is the only thing that says whether the files next to it belong
 * to one analysis, so it must never overstate:
 *
 * - Every artifact written by this scan → `complete`. The content is this run's;
 *   only the closing bookkeeping went wrong.
 * - Nothing written over an earlier *complete* run → that run's manifest is
 *   restored, because the directory still is exactly what that manifest says.
 *   The failure is reported against the run it preserved rather than swallowed.
 * - Anything else → `failed`. A re-scan that got as far as overwriting
 *   `scope`/`profile`/`structure` and then died has left a directory that is
 *   part this scan and part the last one, and calling that complete would
 *   describe a mixed set of artifacts as a single run.
 */
async function settleFailure(
  run: Run,
  manifest: RunManifest,
  previous: RunManifest | null,
  written: ReadonlySet<string>,
  failure: unknown,
): Promise<unknown> {
  if (RUN_ARTIFACTS.every((name) => written.has(name))) {
    return await stampManifest(
      run,
      { ...manifest, status: 'complete', completedAt: new Date().toISOString() },
      failure,
    )
  }

  if (written.size === 0 && previous !== null && previous.status === 'complete') {
    const preserved = new Error(
      `anatomy: scan of ${manifest.source} failed; run ${manifest.runId} keeps its ` +
        `earlier complete result (${messageOf(failure)})`,
      { cause: failure },
    )
    return await stampManifest(run, previous, preserved, failure)
  }

  return await stampManifest(run, manifest, failure)
}

/**
 * Writes the manifest that settles a failed scan and returns what to throw.
 *
 * A failure here must not mask the stage error that got us here: the stage error
 * stays the `cause`, and the write failure is named alongside it, so the reason
 * the scan died is still the first thing a reader sees.
 */
async function stampManifest(
  run: Run,
  next: RunManifest,
  outcome: unknown,
  stageFailure: unknown = outcome,
): Promise<unknown> {
  try {
    await run.write('manifest', next)
    return outcome
  } catch (error) {
    return new Error(
      `anatomy: run ${path.basename(run.dir)} could not record its outcome ` +
        `(${messageOf(error)}); the scan had failed with: ${messageOf(stageFailure)}`,
      { cause: stageFailure },
    )
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
