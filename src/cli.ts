#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { describeRunFailure, estimateAnalyze, runAnalyze, type AnalyzeOptions } from './commands/analyze.js'
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
import { FORGET_USAGE, forget, keepRecent, parseForgetArgs } from './commands/forget.js'
import { DIFF_USAGE, DiffUsageError, formatDiff, parseDiffArgs, runDiff } from './commands/diff.js'
import { DOC_USAGE, DocUsageError, parseDocArgs, runDoc } from './commands/doc.js'
import {
  EXPORT_USAGE,
  ExportArgsError,
  exportDossier,
  formatExport,
  parseExportArgs,
} from './commands/export.js'
import {
  formatHistory,
  HISTORY_USAGE,
  HistoryUsageError,
  parseHistoryArgs,
  runHistory,
} from './commands/history.js'
import { ASK_USAGE, askJson, AskUsageError, formatAsk, parseAskArgs, runAsk } from './commands/ask.js'
import {
  parseResumeArgs,
  RESUME_USAGE,
  resumeJson,
  runResume,
  ResumeUsageError,
} from './commands/resume.js'
import { RUNS_USAGE, formatRuns, listRuns, parseRunsArgs, runsJson } from './commands/runs.js'
import { serveMcp } from './commands/mcp.js'
import {
  APP_DIFF_USAGE,
  APP_REPORT_USAGE,
  INSPECT_APP_USAGE,
  parseInspectAppArgs,
  runAppDiff,
  runAppReport,
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
  --budget <n>       Per-request token budget for the writing layer
  --max-tokens <n>   Whole-run token ceiling (stops before the next candidate)
  --estimate         Price a run with the free scan; no model is called
  --no-cache         Judge every candidate even when this tree was analysed before
  --lang <zh|en>     Report language (default: zh)
  --subpath <path>   Analyse only this subtree
  --ref <ref>        Ref to analyse, when the source is a repository
  --json             Print the JSON report instead of the markdown path`

export type AnalyzeArgs =
  | { help: true }
  | { help: false; input: string; json: boolean; estimate: boolean; options: AnalyzeOptions }

class AnalyzeUsageError extends Error {}

const VALUED_FLAGS = [
  'model',
  'api-key',
  'top',
  'points',
  'budget',
  'max-tokens',
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
  let estimate = false
  let noCache = false
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
    if (name === 'estimate') {
      if (inline !== undefined) {
        throw new AnalyzeUsageError('--estimate takes no value')
      }
      estimate = true
      continue
    }
    if (name === 'no-cache') {
      if (inline !== undefined) {
        throw new AnalyzeUsageError('--no-cache takes no value')
      }
      noCache = true
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
  if (noCache) options.cache = false
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
  const maxTokens = values.get('max-tokens')
  if (maxTokens !== undefined) options.maxTokens = positiveInteger('max-tokens', maxTokens)
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

  return { help: false, input, json, estimate, options }
}

export type CliIo = {
  out: { write(chunk: string): unknown }
  err: { write(chunk: string): unknown }
}

export const MCP_USAGE = `Usage: ana mcp

Serve anatomy over MCP on stdio: anatomy_scan, anatomy_report, anatomy_evidence,
anatomy_forget, and the opt-in anatomy_ask. The first four call no model and read no
key; anatomy_ask spends the environment key's tokens only when the caller passes
spend: true.

The server speaks JSON-RPC 2.0, one message per line. stdout belongs to the
protocol; diagnostics belong on stderr.`

const USAGE = `Usage: ana <command> [options]

Commands:
  scan <repo>        Analyse a repository and list candidate signals (no model calls)
  analyze <repo>     Full analysis: report with evidence-backed learning points
  report <runId>     Re-render a previous run without re-running analysis
  inspect <ref>      Print the source behind one citation (id or path:start-end)
  inspect-app <dir>  Reconstruct a JS/Electron app from shipped artifacts, via REA
  app-report <name>  Re-render the facts report of a reconstructed application
  app-diff <a> <b>   Compare two surveys: what changed on the boundary
  ask <runId> <q>    Ask a finished report a question, citing only its stored evidence
  resume <runId>     Continue an interrupted analysis without paying for judged candidates
  diff <a> <b>       Compare two stored source analyses as facts
  doc <runId>        Write architecture notes from a verified report, plus an optional bundle
  export <runId>     Build the whole dossier from one analysis (0 extra model calls)
  history <runId>    Show the last commit behind each cited file (local checkouts)
  runs [--json]      List the stored analyses, newest first
  forget <id>        Delete one stored run; --keep <n> keeps the newest n
  mcp                Serve the deterministic half over MCP stdio (no model calls)

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
      if (args.estimate) {
        try {
          const estimate = await estimateAnalyze(args.input, args.options)
          if (args.json) {
            io.out.write(`${JSON.stringify(estimate, null, 2)}\n`)
          } else {
            io.out.write(
              `estimate: ${estimate.calls} model request(s), ~${estimate.tokens} tokens ` +
                `(${estimate.judged}/${estimate.candidates} candidates, ${estimate.files} files)\n` +
                `scan run ${estimate.runId} (no model was called)\n`,
            )
          }
          return 0
        } catch (error) {
          io.err.write(`ana: ${describeFailure(error)}\n`)
          return 1
        }
      }
      try {
        const result = await runAnalyze(args.input, {
          ...args.options,
          // The provider's own words, once per distinct failure. The report records
          // the status only; this is the terminal's copy.
          onProviderError: ({ status, excerpt }) => {
            io.err.write(`ana: provider said${status === null ? '' : ` (HTTP ${status})`}: ${excerpt}\n`)
          },
        })
        if (args.json) {
          const jsonPath = result.reportPath.replace(/report\.md$/, 'report.json')
          io.out.write(`${await readFile(jsonPath, 'utf8')}\n`)
        } else {
          io.out.write(`${result.reportPath}\n`)
        }

        // A run whose every model call was rejected is not a run that found nothing.
        // It exited 0 until a wrong API key produced an empty report with a clean
        // status, which is the failure a script cannot see. Client errors (4xx) are
        // not retried, so a non-empty list means the provider refused the whole run.
        // Zero points for a reason the model is responsible for is not the same answer
        // as zero points because there was nothing to learn. The wording lives in
        // `describeRunFailure` because the window asks the same question.
        const failure = describeRunFailure(result)
        if (failure !== '') {
          io.err.write(`ana: ${failure}.\n`)
          return 1
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
        // No special case for `NoSuchRunError`: it used to print `error.message`
        // directly, which skipped the prefix stripping and produced
        // `ana: anatomy: no such run "x"`. Same exit code, same branch, one path.
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'ask': {
      let args
      try {
        args = parseAskArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof AskUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${ASK_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${ASK_USAGE}\n`)
        return 0
      }
      try {
        const answer = await runAsk(args.runId, args.question, args.options)
        io.out.write(args.json ? askJson(answer) : formatAsk(answer))
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'resume': {
      let args
      try {
        args = parseResumeArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof ResumeUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${RESUME_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${RESUME_USAGE}\n`)
        return 0
      }
      try {
        const result = await runResume(args.runId, args.options)
        if (args.json) {
          io.out.write(resumeJson(result))
        } else {
          io.out.write(`${result.reportPath}\n`)
          if (result.reused > 0) {
            io.err.write(`ana: reused ${result.reused} judged candidate(s) from ${args.runId}\n`)
          }
        }
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'diff': {
      let args
      try {
        args = parseDiffArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof DiffUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${DIFF_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${DIFF_USAGE}\n`)
        return 0
      }
      try {
        const diff = await runDiff(args.before, args.after, args.options)
        io.out.write(args.json ? `${JSON.stringify(diff, null, 2)}\n` : formatDiff(diff))
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'doc': {
      let args
      try {
        args = parseDocArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof DocUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${DOC_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${DOC_USAGE}\n`)
        return 0
      }
      try {
        await runDoc(args.runId, args.options, io)
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'history': {
      let args
      try {
        args = parseHistoryArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof HistoryUsageError)) throw error
        io.err.write(`ana: ${error.message}\n\n${HISTORY_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${HISTORY_USAGE}\n`)
        return 0
      }
      try {
        const result = await runHistory(args.runId, args.options)
        io.out.write(
          args.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : formatHistory(result.source, result.entries),
        )
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'export': {
      let args
      try {
        args = parseExportArgs(argv.slice(1))
      } catch (error) {
        if (!(error instanceof ExportArgsError)) throw error
        io.err.write(`ana: ${error.message}\n\n${EXPORT_USAGE}\n`)
        return 2
      }
      if (args.help) {
        io.out.write(`${EXPORT_USAGE}\n`)
        return 0
      }
      try {
        const result = await exportDossier(args.runId, args.options)
        io.out.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatExport(result))
        return 0
      } catch (error) {
        io.err.write(`ana: ${describeFailure(error)}\n`)
        return 1
      }
    }
    case 'mcp': {
      if (argv[1] === '--help' || argv[1] === '-h') {
        io.out.write(`${MCP_USAGE}\n`)
        return 0
      }
      // Stdout is the protocol channel. Anything that would print to it — usage,
      // progress, a stray console.log — corrupts the stream, so the server owns it.
      await serveMcp(process.stdin, process.stdout)
      return 0
    }
    case 'runs': {
      if (argv[1] === '--help' || argv[1] === '-h') {
        io.out.write(`${RUNS_USAGE}\n`)
        return 0
      }
      let parsed
      try {
        parsed = parseRunsArgs(argv.slice(1))
      } catch (error) {
        io.err.write(`ana: ${(error as Error).message}\n\n${RUNS_USAGE}\n`)
        return 2
      }
      if (parsed.help) {
        io.out.write(`${RUNS_USAGE}\n`)
        return 0
      }
      const stored = await listRuns(parsed.baseDir === undefined ? {} : { baseDir: parsed.baseDir })
      io.out.write(parsed.json ? runsJson(stored) : formatRuns(stored))
      return 0
    }
    case 'forget': {
      if (argv[1] === '--help' || argv[1] === '-h') {
        io.out.write(`${FORGET_USAGE}\n`)
        return 0
      }
      let parsed
      try {
        parsed = parseForgetArgs(argv.slice(1))
      } catch (error) {
        io.err.write(`ana: ${(error as Error).message}\n\n${FORGET_USAGE}\n`)
        return 2
      }
      try {
        if (parsed.mode === 'keep') {
          const swept = await keepRecent(parsed.keep, {
            ...(parsed.baseDir === undefined ? {} : { baseDir: parsed.baseDir }),
          })
          for (const removed of swept.removed) io.out.write(`已删除 ${removed}\n`)
          io.out.write(`保留最新的 ${swept.kept.length} 轮，删除 ${swept.removed.length} 轮。\n`)
          return 0
        }
        const result = await forget(parsed.id, {
          target: parsed.target,
          ...(parsed.baseDir === undefined ? {} : { baseDir: parsed.baseDir }),
        })
        if ('missing' in result) {
          io.err.write(`ana: 没有 ${parsed.id}，什么都没删。\n`)
          return 1
        }
        io.out.write(`已删除 ${result.removed}\n`)
        return 0
      } catch (error) {
        io.err.write(`ana: ${(error as Error).message}\n`)
        return 1
      }
    }
    case 'app-diff': {
      if (argv[1] === '--help' || argv[1] === '-h') {
        io.out.write(`${APP_DIFF_USAGE}\n`)
        return 0
      }
      const before = argv[1]
      const after = argv[2]
      if (before === undefined || after === undefined) {
        io.err.write('ana: app-diff 需要两个 survey 目录\n')
        return 2
      }
      await runAppDiff(before, after, io)
      return process.exitCode === 1 ? 1 : 0
    }
    case 'app-report': {
      if (argv[1] === '--help' || argv[1] === '-h') {
        io.out.write(`${APP_REPORT_USAGE}\n`)
        return 0
      }
      const name = argv[1]
      if (name === undefined) {
        io.err.write('ana: app-report 需要一个 survey 目录名\n')
        return 2
      }
      await runAppReport(name, io)
      return process.exitCode === 1 ? 1 : 0
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
