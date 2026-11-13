/**
 * `ana report`: the page again, from the run directory alone.
 *
 * A finished run is a directory full of artifacts, and that is the product's
 * durable half: the extracted tree is deleted when the analysis ends (it is
 * re-acquirable from `source` + `ref`), so a report that needed the sources would
 * only work once, in the same process, before its own cleanup. This command
 * therefore reads — points, validation, synthesis, skipped, profile, scope,
 * manifest — rebuilds the `ReportInput` the renderer takes, and renders.
 *
 * Two rules follow from "stored is enough":
 *
 * - nothing here writes. `openRun` is deliberately not used: it stamps the
 *   manifest, and a reader that repairs what it reads turns a corrupted artifact
 *   into a silent, permanent fact. `readRunArtifact` is the read-only door.
 * - a run is either complete or absent. A manifest that says `failed`, or a
 *   `complete` manifest with an artifact missing, names no report, and the
 *   command says `no such run` instead of rendering a page assembled from half a
 *   run.
 *
 * The one thing the artifacts do not carry is the token budget itself:
 * `analyze` states "N candidates cut by token budget (M tokens)", and M is not
 * persisted. The re-rendered tail states the count and not the size — the count
 * is what a reader can act on, and inventing a size would be worse than omitting
 * it.
 */

import path from 'node:path'

import type {
  Candidate,
  LearningPoint,
  Profile,
  ReportInput,
  Scope,
  StructureIndex,
  ValidationResult,
} from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { renderMarkdown } from '../render/markdown.js'
import { isArtifactName, readManifest, readRunArtifact } from '../store/runs.js'
import type { Synthesis } from '../writing/synthesis.js'
import { BUDGET_CUT_REASON, type AnalyzeSkip } from './analyze.js'

export const REPORT_USAGE = 'Usage: ana report <runId>'

export type ReportOptions = {
  /** Run directory parent. Defaults to `<cwd>/.ana/runs`. */
  baseDir?: string
  /**
   * Print target. Optional because the markdown is also returned: a caller with
   * its own writer, and a caller that wants the string, are both legitimate.
   */
  out?: { write(chunk: string): unknown }
}

export type ReportArgs = { help: true } | { help: false; runId: string }

/** A misuse of the command line: reported with the usage line, never with a stack. */
export class ReportUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportUsageError'
  }
}

/** The id names no run that can be rendered. */
export class NoSuchRunError extends Error {
  constructor(runId: string, reason: string) {
    super(`anatomy: no such run "${runId}" (${reason})`)
    this.name = 'NoSuchRunError'
  }
}

/**
 * Parses `report` arguments: exactly one run id, and `--help`.
 *
 * There is nothing to configure: the run id is the whole request, and the parent
 * directory is the caller's (a test's, a script's) concern rather than a flag.
 */
export function parseReportArgs(argv: string[]): ReportArgs {
  const positional: string[] = []

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg !== '-' && arg.startsWith('-')) {
      throw new ReportUsageError(`unknown option "${arg}"`)
    }
    positional.push(arg)
  }

  if (positional.length === 0) throw new ReportUsageError('report needs a run id')
  if (positional.length > 1) {
    throw new ReportUsageError(`report takes one run id, got ${positional.length}`)
  }
  return { help: false, runId: positional[0] as string }
}

/**
 * The stored skip list as the report tail's lines.
 *
 * `analyze` writes one `path:line reason` per entry after a summary line for the
 * budget cut; this rebuilds the same shape from the artifact, minus the token
 * total the artifacts never held (see the file header).
 */
export function skipLinesFrom(skipped: AnalyzeSkip[]): string[] {
  const cut = skipped.filter((entry) => entry.reason === BUDGET_CUT_REASON).length
  const lines: string[] = []
  if (cut > 0) lines.push(`${cut} candidates ${BUDGET_CUT_REASON}`)
  for (const entry of skipped) {
    lines.push(entry.path === '' ? entry.reason : `${entry.path}:${entry.line} ${entry.reason}`)
  }
  return lines
}

/** Reads one artifact or rejects the run as incomplete, naming what is missing. */
async function requireArtifact<T>(
  baseDir: string,
  runId: string,
  name: string,
): Promise<T> {
  const value = await readRunArtifact<T>(baseDir, runId, name)
  if (value === null) throw new NoSuchRunError(runId, `it has no ${name} artifact`)
  return value
}

/**
 * The `ReportInput` a stored run describes, rebuilt from its artifacts.
 *
 * The casts say "these artifacts were written by this package"; the renderer is
 * the layer that distrusts their contents, so a malformed point is withheld
 * there, with a stated reason, rather than by a crash here.
 */
export async function readReportInput(
  runId: string,
  opts: ReportOptions = {},
): Promise<ReportInput> {
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  // An id that cannot be a directory name cannot name a run, and must not be
  // handed to the filesystem at all.
  if (!isArtifactName(runId)) throw new NoSuchRunError(runId, 'it is not a run id')

  const manifest = await readManifest(baseDir, runId)
  if (manifest === null || manifest.status !== 'complete') {
    throw new NoSuchRunError(runId, `no completed run in ${baseDir}`)
  }

  const [points, validation, synthesis, skipped, profile, scope] = await Promise.all([
    requireArtifact<LearningPoint[]>(baseDir, runId, 'points'),
    requireArtifact<ValidationResult>(baseDir, runId, 'validation'),
    requireArtifact<Synthesis>(baseDir, runId, 'synthesis'),
    requireArtifact<AnalyzeSkip[]>(baseDir, runId, 'skipped'),
    requireArtifact<Profile>(baseDir, runId, 'profile'),
    requireArtifact<Scope>(baseDir, runId, 'scope'),
  ])

  // Read, not required: these feed the appendix, and a run written before the
  // appendix existed must still render. A missing artifact drops one section; a
  // `requireArtifact` here would make every old run unreadable.
  const [candidates, structure] = await Promise.all([
    readRunArtifact<Candidate[]>(baseDir, runId, 'candidates'),
    readRunArtifact<StructureIndex>(baseDir, runId, 'structure'),
  ])

  return {
    source: typeof manifest.source === 'string' ? manifest.source : '',
    problem: synthesis.problem,
    topFive: synthesis.topFive,
    points,
    validation,
    profile,
    scope,
    skipped: skipLinesFrom(skipped),
    ...(candidates === null ? {} : { candidates }),
    ...(structure === null ? {} : { structure }),
  }
}

/**
 * Renders the stored run `runId` and, when a writer was given, prints it.
 *
 * No network, no kernel stage, no tree: the directory is the input and stays
 * exactly as it was.
 */
export async function runReport(runId: string, opts: ReportOptions = {}): Promise<string> {
  const markdown = renderMarkdown(await readReportInput(runId, opts))
  opts.out?.write(markdown)
  return markdown
}
