import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readVersion, runCli } from '../src/cli.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const builtCli = join(repoRoot, 'dist', 'cli.js')

// Read the manifest independently of src/cli.ts so the version assertion
// cannot be satisfied by a shared fallback.
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string
}
const packageVersion = pkg.version

function capture() {
  let out = ''
  let err = ''
  return {
    io: {
      out: { write: (chunk: string) => (out += chunk) },
      err: { write: (chunk: string) => (err += chunk) },
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
  }
}

describe('ana cli', () => {
  it('prints the package version on --version', async () => {
    const cap = capture()
    const code = await runCli(['--version'], cap.io)
    expect(code).toBe(0)
    expect(cap.out).toBe(`${packageVersion}\n`)
  })

  it('readVersion returns the exact package.json version', () => {
    expect(readVersion()).toBe(packageVersion)
  })

  it('prints usage to stderr with exit code 2 when called bare', async () => {
    const cap = capture()
    const code = await runCli([], cap.io)
    expect(code).toBe(2)
    expect(cap.err).toContain('Usage: ana')
    expect(cap.out).toBe('')
  })

  it('rejects an unknown command with exit code 2', async () => {
    const cap = capture()
    const code = await runCli(['bogus'], cap.io)
    expect(code).toBe(2)
    expect(cap.err).toContain('unknown command')
    expect(cap.err).toContain('bogus')
  })

  it('prints usage to stdout with exit code 0 on --help', async () => {
    const cap = capture()
    const code = await runCli(['--help'], cap.io)
    expect(code).toBe(0)
    expect(cap.out).toContain('Usage: ana')
    expect(cap.err).toBe('')
  })
})

describe('built artifact', () => {
  let workDir: string | undefined

  beforeAll(() => {
    const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    execFileSync(process.execPath, [tsc], { cwd: repoRoot, stdio: 'pipe' })
    chmodSync(builtCli, 0o755)
  }, 180_000)

  afterAll(() => {
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true })
  })

  it('starts with a node shebang', () => {
    const firstLine = readFileSync(builtCli, 'utf8').split('\n', 1)[0]
    expect(firstLine).toBe('#!/usr/bin/env node')
  })

  it('runs as an executable and prints the version', () => {
    const result = spawnSync(builtCli, ['--version'], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(packageVersion)
  })

  it('runs when invoked through a symlink', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ana-bin-'))
    const link = join(workDir, 'ana')
    symlinkSync(builtCli, link)

    const result = spawnSync(link, ['--version'], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(packageVersion)
  })

  it('installs a rejection handler on the entry point', () => {
    const source = readFileSync(builtCli, 'utf8')
    expect(source).toMatch(/\.catch\(/)
    expect(source).toContain('process.exitCode = 1')
  })
})
