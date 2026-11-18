import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ANALYZE_USAGE, parseAnalyzeArgs, readVersion, runCli } from '../src/cli.js'
import { ASK_USAGE } from '../src/commands/ask.js'
import { DIFF_USAGE } from '../src/commands/diff.js'
import { DOC_USAGE } from '../src/commands/doc.js'
import { HISTORY_USAGE } from '../src/commands/history.js'
import { EXPORT_USAGE } from '../src/commands/export.js'
import { INSPECT_USAGE } from '../src/commands/inspect.js'
import { REPORT_USAGE } from '../src/commands/report.js'
import { RESUME_USAGE } from '../src/commands/resume.js'
import { storedRun } from './helpers/run-fixture.js'

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

describe('analyze grammar', () => {
  it('accepts --flag=value and --flag value as the same grammar', () => {
    const separated = parseAnalyzeArgs(['repo', '--top', '3', '--lang', 'en'])
    const joined = parseAnalyzeArgs(['repo', '--top=3', '--lang=en'])

    expect(joined).toEqual(separated)
    expect(joined).toMatchObject({ help: false, input: 'repo', json: false })
    expect(joined).toMatchObject({ options: { top: 3, lang: 'en' } })
  })

  it('carries every documented flag to the run options', () => {
    const parsed = parseAnalyzeArgs([
      'repo',
      '--model=gpt-4o-mini',
      '--api-key',
      'k',
      '--budget=5000',
      '--subpath',
      'src',
      '--ref=main',
    ])

    expect(parsed).toMatchObject({
      help: false,
      input: 'repo',
      options: {
        model: 'gpt-4o-mini',
        apiKey: 'k',
        budget: 5000,
        subpath: 'src',
        ref: 'main',
      },
    })
  })

  it('reads --json as a switch and refuses a value for it', () => {
    expect(parseAnalyzeArgs(['repo', '--json'])).toMatchObject({ json: true })
    expect(() => parseAnalyzeArgs(['repo', '--json=yes'])).toThrow(/takes no value/)
  })

  it('refuses an unknown language, a non-positive count and a forgotten value', () => {
    expect(() => parseAnalyzeArgs(['repo', '--lang=fr'])).toThrow(/--lang/)
    expect(() => parseAnalyzeArgs(['repo', '--top=0'])).toThrow(/positive integer/)
    expect(() => parseAnalyzeArgs(['repo', '--budget=abc'])).toThrow(/positive integer/)
    expect(() => parseAnalyzeArgs(['repo', '--model'])).toThrow(/needs a value/)
  })
})

describe('analyze, report and inspect wiring', () => {
  it('answers analyze --help with its own usage', async () => {
    const cap = capture()
    expect(await runCli(['analyze', '--help'], cap.io)).toBe(0)
    expect(cap.out).toBe(`${ANALYZE_USAGE}\n`)
    expect(cap.err).toBe('')
  })

  it('reports analyze misuse on stderr with exit code 2', async () => {
    const argvCases = [
      ['analyze'],
      ['analyze', 'a', 'b'],
      ['analyze', 'repo', '--bogus'],
      ['analyze', 'repo', '--lang', 'fr'],
      ['analyze', 'repo', '--top', '0'],
      ['analyze', 'repo', '--budget'],
      ['analyze', 'repo', '-x'],
    ]
    for (const argv of argvCases) {
      const cap = capture()
      expect(await runCli(argv, cap.io), argv.join(' ')).toBe(2)
      expect(cap.err).toContain(ANALYZE_USAGE)
      expect(cap.out).toBe('')
    }
  })

  it('answers diff --help with its own usage', async () => {
    const diff = capture()
    expect(await runCli(['diff', '--help'], diff.io)).toBe(0)
    expect(diff.out).toBe(`${DIFF_USAGE}\n`)
    expect(diff.err).toBe('')
  })

  it('reports diff misuse with exit code 2', async () => {
    for (const argv of [['diff'], ['diff', 'a'], ['diff', 'a', 'b', '--bogus']]) {
      const cap = capture()
      expect(await runCli(argv, cap.io), argv.join(' ')).toBe(2)
      expect(cap.err).toContain(DIFF_USAGE)
      expect(cap.out).toBe('')
    }
  })

  it('answers export --help with its own usage', async () => {
    const exp = capture()
    expect(await runCli(['export', '--help'], exp.io)).toBe(0)
    expect(exp.out).toBe(`${EXPORT_USAGE}\n`)
  })

  it('reports export misuse with exit code 2', async () => {
    for (const argv of [['export'], ['export', 'run-1', '--bogus']]) {
      const cap = capture()
      expect(await runCli(argv, cap.io), argv.join(' ')).toBe(2)
      expect(cap.out).toBe('')
    }
  })

  it('answers doc and history --help with their own usage', async () => {
    const doc = capture()
    expect(await runCli(['doc', '--help'], doc.io)).toBe(0)
    expect(doc.out).toBe(`${DOC_USAGE}\n`)

    const history = capture()
    expect(await runCli(['history', '-h'], history.io)).toBe(0)
    expect(history.out).toBe(`${HISTORY_USAGE}\n`)
  })

  it('reports doc and history misuse with exit code 2', async () => {
    for (const argv of [
      ['doc'],
      ['doc', 'run-1', '--bogus'],
      ['history'],
      ['history', 'a', 'b'],
    ]) {
      const cap = capture()
      expect(await runCli(argv, cap.io), argv.join(' ')).toBe(2)
      expect(cap.out).toBe('')
    }
  })

  it('answers ask --help and resume --help with their own usage', async () => {
    const ask = capture()
    expect(await runCli(['ask', '--help'], ask.io)).toBe(0)
    expect(ask.out).toBe(`${ASK_USAGE}\n`)
    expect(ask.err).toBe('')

    const resume = capture()
    expect(await runCli(['resume', '-h'], resume.io)).toBe(0)
    expect(resume.out).toBe(`${RESUME_USAGE}\n`)
    expect(resume.err).toBe('')
  })

  it('reports ask and resume misuse with exit code 2', async () => {
    for (const argv of [
      ['ask'],
      ['ask', 'run-1'],
      ['ask', 'run-1', 'why', '--lang', 'fr'],
      ['resume'],
      ['resume', 'a', 'b'],
      ['resume', 'a', '--max-tokens', '0'],
    ]) {
      const cap = capture()
      expect(await runCli(argv, cap.io), argv.join(' ')).toBe(2)
      expect(cap.out).toBe('')
    }
  })

  it('answers report --help and inspect --help with their own usage', async () => {
    const report = capture()
    expect(await runCli(['report', '-h'], report.io)).toBe(0)
    expect(report.out).toBe(`${REPORT_USAGE}\n`)

    const inspect = capture()
    expect(await runCli(['inspect', '--help'], inspect.io)).toBe(0)
    expect(inspect.out).toBe(`${INSPECT_USAGE}\n`)
  })

  it('reports a missing run id or evidence id as usage', async () => {
    const report = capture()
    expect(await runCli(['report'], report.io)).toBe(2)
    expect(report.err).toContain(REPORT_USAGE)

    const inspect = capture()
    expect(await runCli(['inspect'], inspect.io)).toBe(2)
    expect(inspect.err).toContain(INSPECT_USAGE)
  })

  it('reports an unknown run or evidence as a runtime failure with exit code 1', async () => {
    const report = capture()
    expect(await runCli(['report', 'no-such-run-id'], report.io)).toBe(1)
    expect(report.err.startsWith('ana: ')).toBe(true)
    expect(report.err).toContain('no such run')
    expect(report.out).toBe('')

    const inspect = capture()
    expect(await runCli(['inspect', 'no-such-evidence-id'], inspect.io)).toBe(1)
    expect(inspect.err).toContain('no such evidence')
  })

  it('prints a stored run page and looks its evidence up by id', async () => {
    // The commands read `<cwd>/.ana/runs` when no parent is given, so the run has
    // to live there; only this one directory is removed afterwards.
    const runs = join(repoRoot, '.ana', 'runs')
    const runId = `cli-test-${process.pid}-${Date.now()}`
    try {
      storedRun(runs, runId, {
        evidence: {
          id: `${runId}-evidence`,
          path: 'src/a.ts',
          startLine: 12,
          endLine: 14,
          snippet: 'const q: number[] = []',
        },
      })

      const page = capture()
      expect(await runCli(['report', runId], page.io)).toBe(0)
      expect(page.out).toContain('# demo')
      expect(page.out).toContain('## 这次分析的可信度')
      expect(page.err).toBe('')

      const evidence = capture()
      expect(await runCli(['inspect', `${runId}-evidence`], evidence.io)).toBe(0)
      expect(evidence.out).toBe('src/a.ts:12-14\nconst q: number[] = []\n')
    } finally {
      rmSync(join(runs, runId), { recursive: true, force: true })
    }
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
