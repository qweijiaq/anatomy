#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { runAnalyze, type AnalyzeOptions } from './commands/analyze.js'
import {
  INSPECT_USAGE,
  InspectUsageError,
  parseInspectArgs,
  runInspect,
} from './commands/inspect.js'
import {
  NoSuchRunError,
  parseReportArgs,
  REPORT_USAGE,
  ReportUsageError,
  runReport,
} from './commands/report.js'
import {
  parseScanArgs,
  runScan,
  SCAN_USAGE,
  ScanUsageError,
  type ScanIo,
} from './commands/scan.js'
import {
  INSPECT_APP_USAGE,
  parseInspectAppArgs,
  runInspectApp,
} from './commands/inspect-app.js'
import { readVersion } from './version.js'

export { readVersion }

export const ANALYZE_USAGE = `Usage: ana analyze <repo> [options]

Options:
  --model <name>     Model name (default: $ANA_MODEL or the built-in default)
  --api-key <key>    Overrides $ANA_API_KEY
  --top <n>          How many candidate signals to collect
  --points <n>       How many points the report may hold (default 5, max 12)
  --budget <n>       Token budget for the writing layer
  --lang <zh|en>     Report language (default: zh)
  --subpath <path>   Analyse only this subtree
  --ref <ref>        Ref to analyse, when the source is a repository
  --json             Print the JSON report instead of the markdown path`

export type AnalyzeArgs =
  | { help: true }
  | { help: false; input: string; json: boolean; options: AnalyzeOptions }

class AnalyzeUsageError extends Error {}

const VALUED_FLAGS = [
  'model',
  'api-key',
  'top',
  'points',
  'budget',
  'lang',
  'subpath',
  'ref',
] as const

function positiveInteger(flag: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new AnalyzeUsageError(`--${flag} expects a positive integer, got "${raw}"`)
  }
  return value
}

/** The analyze grammar, kept pure so the CLI and its tests share one parse. */
export function parseAnalyzeArgs(argv: string[]): AnalyzeArgs {
  const positional: string[] = []
  const values = new Map<string, string>()
  let json = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const [name = '', inline] = token.replace(/^--?/, '').split('=', 2)
    if (name === 'json') {
      if (inline !== undefined) {
        throw new AnalyzeUsageError('--json takes no value')
      }
      json = true
      continue
    }
    if (!(VALUED_FLAGS as readonly string[]).includes(name)) {
      throw new AnalyzeUsageError(`unknown option "${token}"`)
    }
    if (inline !== undefined) {
      values.set(name, inline)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new AnalyzeUsageError(`--${name} needs a value`)
    }
    values.set(name, next)
    index += 1
  }

  if (help) return { help: true }
  const [input, ...rest] = positional
  if (input === undefined) {
    throw new AnalyzeUsageError('missing <repo>')
  }
  if (rest.length > 0) {
    throw new AnalyzeUsageError(`unexpected argument "${rest[0]}"`)
  }

  const options: AnalyzeOptions = {}
  const model = values.get('model')
  if (model !== undefined) options.model = model
  const apiKey = values.get('api-key')
  if (apiKey !== undefined) options.apiKey = apiKey
  const top = values.get('top')
  if (top !== undefined) options.top = positiveInteger('top', top)
  const points = values.get('points')
  if (points !== undefined) options.reportPoints = positiveInteger('points', points)
  const budget = values.get('budget')
  if (budget !== undefined) options.budget = positiveInteger('budget', budget)
  const subpath = values.get('subpath')
  if (subpath !== undefined) options.subpath = subpath
  const ref = values.get('ref')
  if (ref !== undefined) options.ref = ref
  const lang = values.get('lang')
  if (lang !== undefined) {
    if (lang !== 'zh' && lang !== 'en') {
      throw new AnalyzeUsageError(`--lang expects "zh" or "en", got "${lang}"`)
    }
    options.lang = lang
  }

  return { help: false, input, json, options }
}

export type CliIo = {
  out: { write(chunk: string): unknown }
  err: { write(chunk: string): unknown }
}

const USAGE = `Usage: ana <command> [options]

Commands:
  scan <repo>        Analyse a repository and list candidate signals (no model calls)
  analyze <repo>     Full analysis: report with evidence-backed learning points
  report <runId>     Re-render a previous run without re-running analysis
  inspect <evId>     Print the source behind one evidence id
  inspect-app <dir>  Reconstruct a JS/Electron app from shipped artifacts, via REA

Options:
  --version          Print the version
  --help             Print this message

${SCAN_USAGE}

<repo> may be a GitHub URL, a tarball URL, or a local directory.
`

/**
 * One failure, one prefix.
 *
 * Kernel errors already carry the package name (`anatomy: ...`) because they are
 * also seen by library callers with no CLI around them; the CLI speaks as `ana`,
 * and `ana: anatomy: root "x" does not exist` says the same thing twice.
 */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Kernel errors already say `anatomy:`; the CLI speaks as `ana`, and a
  // pipeline that wrapped a kernel failure can nest the prefix twice.
  return message.replace(/^(?:anatomy: )+/, '')
}

export async function runCli(
  argv: string[],
  io: CliIo = { out: process.stdout, err: process.stderr },
): Promise<number> {
  const [command] = argv

  if (command === '--version' || command === '-v') {
    io.out.write(`${readVersion()}\n`)
    return 0
  }

  if (command === '--help' || command === '-h') {
    io.out.write(USAGE)
    return 0
  }

  if (command === undefined) {
    io.err.write(USAGE)
    return 2
  }

  switch (command) {
    case 'scan': {
      let args
      try {
        args = parseScanArgs(argv.slice(1))
      } catch (error) {
        // Misuse is not a failed scan: the run never started, so it says what the
        // command accepts instead of pretending something went wrong on disk.
        if (!(error instanceof ScanUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${SCAN_USAGE}\n`)
        return 2
      }
      if (args.help) {
        // Asking how to use a command is not a misuse of it.
        io.out.write(`${SCAN_USAGE}\n`)
        return 0
      }
      try {
        await runScan(args.repo, args.options, io satisfies ScanIo)
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'analyze': {
      let args: AnalyzeArgs
      try {
        args = parseAnalyzeArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof AnalyzeUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${ANALYZE_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${ANALYZE_USAGE}\n`)
        return 0
      }
      try {
        const result = await runAnalyze(args.input, args.options)
        if (args.json) {
          const jsonPath = result.reportPath.replace(/report\.md$/, 'report.json')
          io.out.write(`${await readFile(jsonPath, 'utf8')}\n`)
        } else {
          io.out.write(`${result.reportPath}\n`)
        }
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'report': {
      let args
      try {
        args = parseReportArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof ReportUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${REPORT_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${REPORT_USAGE}\n`)
        return 0
      }
      try {
        await runReport(args.runId, { out: io.out })
        return 0
      } catch (error) {
        if (error instanceof NoSuchRunError) {
          io.err.write(`ana: ${error.message}\n`)
          return 1
        }
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'inspect-app': {
      let args
      try {
        args = parseInspectAppArgs(argv.slice(1))
      } catch (error) {
        io.err.write(`ana: ${(error as Error).message}\n\n${INSPECT_APP_USAGE}\n`)
        return 2
      }
      try {
        const original = process.stdout.write.bind(process.stdout)
        // The command writes through its own stream so tests can capture it.
        void original
        await runInspectApp(args)
        return process.exitCode === 1 ? 1 : 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'inspect': {
      let args
      try {
        args = parseInspectArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof InspectUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${INSPECT_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${INSPECT_USAGE}\n`)
        return 0
      }
      try {
        await runInspect(args.evidenceId, { out: io.out })
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    default:
      io.err.write(`ana: unknown command "${command}"\n\n${USAGE}`)
      return 2
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    // Resolve symlinks so `node_modules/.bin/ana` matches the real module URL.
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isDirectRun()) {
  void runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      process.stderr.write(`ana: ${describeFailure(err)}\n`)
      process.exitCode = 1
    })
}
