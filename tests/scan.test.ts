import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { runCli } from '../src/cli.js'
import { formatScanReport, runScan } from '../src/commands/scan.js'
import type { Candidate, Profile, Scope, StructureIndex } from '../src/contracts/types.js'

const fixtureRepo = fileURLToPath(new URL('./fixtures/scan-repo/', import.meta.url)).replace(
  /\/$/,
  '',
)

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temporaryDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** The CLI's own capture: the command writes through whatever `io` it is given. */
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

async function artifact<T>(out: string, runId: string, name: string): Promise<T> {
  const text = await readFile(path.join(out, runId, `${name}.json`), 'utf8')
  return JSON.parse(text) as T
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'src/a.ts:1:custom-infra',
  path: 'src/a.ts',
  line: 1,
  kind: 'custom-infra',
  score: 6,
  matched: ['scheduler'],
  ...over,
})

const scopeOf = (over: Partial<Scope> = {}): Scope => ({
  root: '/repo',
  files: [],
  excluded: [{ reason: 'vendored', count: 2 }],
  totals: { files: 12, bytes: 2048, lines: 340 },
  byLanguage: { ts: 3 },
  ...over,
})

// --- the assembly ---------------------------------------------------------

describe('runScan', () => {
  it('writes manifest, profile, structure and candidates into the run directory', async () => {
    const out = await temporaryDir('ana-scan-')
    const cap = capture()

    const result = await runScan(fixtureRepo, { out, topK: 5 }, cap.io)

    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.length).toBeLessThanOrEqual(5)

    expect(await artifact<Profile>(out, result.runId, 'profile')).toMatchObject({
      manifests: ['package.json'],
    })
    expect(await artifact<Candidate[]>(out, result.runId, 'candidates')).toHaveLength(
      result.candidates.length,
    )
    const structure = await artifact<StructureIndex>(out, result.runId, 'structure')
    expect(structure.symbols.map((symbol) => symbol.name)).toContain('Scheduler')

    // The run exists on disk, the extracted tree does not: artifacts are the run.
    expect(existsSync(path.join(out, result.runId, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(out, result.runId, 'tree'))).toBe(false)
  })

  it('prints a header naming the run, the file counts and the exclusion tally', async () => {
    const out = await temporaryDir('ana-scan-')
    const cap = capture()

    const result = await runScan(fixtureRepo, { out, topK: 5 }, cap.io)
    const [header] = cap.out.split('\n')

    expect(header).toContain(result.runId)
    expect(header).toMatch(/\d+ files, \d+ lines/)
    expect(header).toContain('excluded vendored 1')
  })

  it('prints a path:line row for the known signal in src/scheduler.ts', async () => {
    const out = await temporaryDir('ana-scan-')
    const cap = capture()

    await runScan(fixtureRepo, { out, topK: 5 }, cap.io)

    const rows = cap.out.trimEnd().split('\n').slice(1)
    const schedulerRows = rows.filter((row) => row.startsWith('src/scheduler.ts:'))
    expect(schedulerRows.length).toBeGreaterThan(0)
    expect(schedulerRows[0]).toMatch(/^src\/scheduler\.ts:\d+ {2}\d+ {2}[a-z-]+$/)
    // Every printed row is a candidate, never a vendored file the scope dropped.
    expect(rows.some((row) => row.includes('vendor/'))).toBe(false)
  })

  it('mints the same run id for the same tree', async () => {
    const out = await temporaryDir('ana-scan-')
    const cap = capture()

    const first = await runScan(fixtureRepo, { out, topK: 5 }, cap.io)
    const second = await runScan(fixtureRepo, { out, topK: 5 }, cap.io)

    expect(second.runId).toBe(first.runId)
  })
})

// --- the table, without capturing stdout ----------------------------------

describe('formatScanReport', () => {
  it('prints the header even when nothing was found', () => {
    const text = formatScanReport({
      runId: 'abc123def456',
      scope: scopeOf(),
      candidates: [],
    })

    expect(text.split('\n')[0]).toBe('run abc123def456  12 files, 340 lines  excluded vendored 2')
    expect(text).toContain('no candidates')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('prints at most ten candidates as path:line, score and kind', () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate({
        id: `src/f${index}.ts:${index + 1}:custom-infra`,
        path: `src/f${index}.ts`,
        line: index + 1,
        score: 20 - index,
      }),
    )

    const text = formatScanReport({
      runId: 'abc123def456',
      scope: scopeOf(),
      candidates,
    })
    const rows = text.trimEnd().split('\n').slice(1)

    expect(rows).toHaveLength(10)
    expect(rows[0]).toBe('src/f0.ts:1  20  custom-infra')
    expect(rows[9]).toBe('src/f9.ts:10  11  custom-infra')
  })

  it('says so when nothing was excluded', () => {
    const text = formatScanReport({
      runId: 'abc123def456',
      scope: scopeOf({ excluded: [] }),
      candidates: [candidate()],
    })

    expect(text.split('\n')[0]).toContain('nothing excluded')
  })
})

// --- the command line -----------------------------------------------------

describe('ana scan', () => {
  it('exits 1 with ana: on a path that does not exist', async () => {
    const out = await temporaryDir('ana-scan-')
    const cap = capture()

    const code = await runCli(['scan', path.join(out, 'missing-repo')], cap.io)

    expect(code).toBe(1)
    expect(cap.out).toBe('')
    expect(cap.err).toMatch(/^ana: /)
    // The kernel's own `anatomy:` prefix is the package name, not the CLI's: one prefix.
    expect(cap.err).not.toContain('anatomy:')
  })

  it('rejects a missing repository with the scan usage line', async () => {
    const cap = capture()

    const code = await runCli(['scan'], cap.io)

    expect(code).toBe(2)
    expect(cap.out).toBe('')
    expect(cap.err).toContain('Usage: ana scan')
  })

  it('rejects an unknown flag instead of ignoring it', async () => {
    const cap = capture()

    const code = await runCli(['scan', fixtureRepo, '--top', '3', '--lang', 'en'], cap.io)

    expect(code).toBe(2)
    expect(cap.err).toContain('--lang')
    expect(cap.err).toContain('Usage: ana scan')
  })

  it('rejects a --top that is not a positive integer', async () => {
    const cap = capture()

    const code = await runCli(['scan', fixtureRepo, '--top', 'lots'], cap.io)

    expect(code).toBe(2)
    expect(cap.err).toContain('--top')
    expect(cap.err).toContain('Usage: ana scan')
  })
})
