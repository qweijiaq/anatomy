/**
 * `ana scan`: the kernel, with no model calls and no writing layer.
 *
 * The command exists to answer one question cheaply — *where is the interesting
 * part of this repository?* — so it is a thin shell over `scanRepo`: acquire,
 * scope, profile, structure, signals, persist, print. The printing lives in a pure
 * formatter (`formatScanReport`) rather than in `runScan`, so the table can be
 * asserted without capturing stdout, and so a later `ana report` can reuse the
 * same shape.
 *
 * Argument parsing is here rather than in `cli.ts` because the flags belong to
 * this command: the dispatcher knows the command name, the command knows its
 * grammar. Anything outside that grammar is a usage error, not something to
 * ignore — a silently dropped `--ref` analyses the wrong commit.
 */

import type { Candidate, Profile, Scope } from '../contracts/types.js'
import { scanRepo, type PipelineOptions } from '../kernel/pipeline.js'

/** Rows the table shows; the run may hold `DEFAULT_TOP_K` (30) or as many as `--top` asked for. */
export const TABLE_ROWS = 10

export const SCAN_USAGE =
  'Usage: ana scan <repo> [--top <n>] [--subpath <dir>] [--ref <ref>]'

export type ScanOptions = {
  /** Run directory parent. Defaults to `<cwd>/.ana/runs`. */
  out?: string
  subpath?: string
  ref?: string
  topK?: number
  /** Injected acquisition dependencies, so tests never touch the network. */
  deps?: PipelineOptions['deps']
}

export type ScanSummary = {
  runId: string
  candidates: Candidate[]
  profile: Profile
  /**
   * What the scan actually looked at.
   *
   * Not printed by the report (which shows totals and exclusions), but the callers
   * that ask "did it even see my file?" need the inventory: the MCP tool can report
   * coverage, and a test can assert a binary was excluded rather than parsed.
   */
  scope: Scope
}

export type ScanIo = { out: { write(chunk: string): unknown } }

/** A misuse of the command line: reported with the usage line, never with a stack. */
export class ScanUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScanUsageError'
  }
}

/**
 * Either a request for the usage line — `--help` says nothing about the run, so
 * it needs no repository — or a scan to perform.
 */
export type ScanArgs = { help: true } | { help: false; repo: string; options: ScanOptions }

/**
 * Parses `scan` arguments: exactly one repository, then `--top`, `--subpath` and
 * `--ref`. Both a flag's value and the repository are positional in the sense that
 * order does not matter, but a value never starts with `--`: that is the shape of a
 * forgotten argument, and guessing would analyse the wrong thing.
 *
 * `--flag=value` and `--flag value` are the same grammar — the `=` form is what
 * `--top=5` looks like to everyone who has used a unix tool — and `--help`/`-h`
 * short-circuits the grammar entirely, so `ana scan --help` answers instead of
 * complaining that a repository is missing.
 */
export function parseScanArgs(argv: string[]): ScanArgs {
  const positional: string[] = []
  const options: ScanOptions = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--help' || arg === '-h') return { help: true }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = equals === -1 ? arg : arg.slice(0, equals)
      let value: string
      if (equals === -1) {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
          throw new ScanUsageError(`${name} needs a value`)
        }
        value = next
        index += 1
      } else {
        value = arg.slice(equals + 1)
        if (value === '') throw new ScanUsageError(`${name} needs a value`)
      }
      if (name === '--top') options.topK = positiveInteger(value)
      else if (name === '--subpath') options.subpath = value
      else if (name === '--ref') options.ref = value
      else throw new ScanUsageError(`unknown option "${name}"`)
      continue
    }

    if (arg !== '-' && arg.startsWith('-')) {
      throw new ScanUsageError(`unknown option "${arg}"`)
    }
    positional.push(arg)
  }

  if (positional.length === 0) throw new ScanUsageError('scan needs a repository')
  if (positional.length > 1) {
    throw new ScanUsageError(`scan takes one repository, got ${positional.length}`)
  }
  return { help: false, repo: positional[0] as string, options }
}

function positiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ScanUsageError(`--top needs a positive integer (got "${value}")`)
  }
  return Number.parseInt(value, 10)
}

/**
 * The whole table as text: one header line naming the run, the file counts and the
 * exclusion tally, then the highest-scoring candidates as `path:line  score  kind`.
 *
 * Pure — same report, same string — because the printed lines are the command's
 * only user-visible product and the easiest thing to get subtly wrong.
 */
export function formatScanReport(report: {
  runId: string
  scope: Scope
  candidates: Candidate[]
}): string {
  const { runId, scope, candidates } = report
  const excluded =
    scope.excluded.length === 0
      ? 'nothing excluded'
      : `excluded ${scope.excluded.map((entry) => `${entry.reason} ${entry.count}`).join(', ')}`
  const header = `run ${runId}  ${scope.totals.files} files, ${scope.totals.lines} lines  ${excluded}`

  const rows = candidates
    .slice(0, TABLE_ROWS)
    .map((candidate) => `${candidate.path}:${candidate.line}  ${candidate.score}  ${candidate.kind}`)
  // An empty table is a result, not a failure: say what was looked at, so a quiet
  // repository cannot be mistaken for a broken scan.
  const body = rows.length === 0 ? [`no candidates in ${scope.totals.files} files`] : rows

  return `${[header, ...body].join('\n')}\n`
}

/**
 * Runs the kernel over `input`, prints the table and hands back what it found.
 *
 * Artifacts are already on disk when this returns (`scanRepo` wrote them); the
 * returned values are for callers that want the data without re-reading the run.
 */
export async function runScan(
  input: string,
  opts: ScanOptions = {},
  io: ScanIo = { out: process.stdout },
): Promise<ScanSummary> {
  const result = await scanRepo(input, {
    subpath: opts.subpath,
    ref: opts.ref,
    topK: opts.topK,
    baseDir: opts.out,
    deps: opts.deps,
  })

  io.out.write(formatScanReport(result))

  return {
    runId: result.runId,
    candidates: result.candidates,
    profile: result.profile,
    scope: result.scope,
  }
}
