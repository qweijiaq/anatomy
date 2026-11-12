#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

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

<repo> may be a GitHub URL, a tarball URL, or a local directory.
`

const require = createRequire(import.meta.url)

export function readVersion(): string {
  const pkg = require('../package.json') as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no "version" field')
  }
  return pkg.version
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
    case 'scan':
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
      process.stderr.write(
        `ana: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exitCode = 1
    })
}
