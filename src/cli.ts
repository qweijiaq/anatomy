#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  parseScanArgs,
  runScan,
  SCAN_USAGE,
  ScanUsageError,
  type ScanIo,
} from './commands/scan.js'
import { readVersion } from './version.js'

export { readVersion }

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
  return message.replace(/^anatomy: /, '')
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
    case 'analyze':
    case 'report':
    case 'inspect':
      io.err.write(`ana: "${command}" is not implemented yet\n`)
      return 2
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
