import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { runCli } from '../src/cli.js'
import { formatScanReport, parseScanArgs, runScan, type ScanArgs } from '../src/commands/scan.js'
import type {
  Candidate,
  Profile,
  RunManifest,
  Scope,
  StructureIndex,
} from '../src/contracts/types.js'
import { scanRepo } from '../src/kernel/pipeline.js'
import { file, gzip, tar } from './helpers/tar.js'

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

  it('exits 1 with ana: when a stage fails, and leaves no tree behind', async () => {
    const out = await temporaryDir('ana-scan-')
    const cap = capture()
    // `--out` is not a flag: the run lands in `<cwd>/.ana/runs`, so the scan runs
    // from a throwaway cwd rather than dropping a run into the repository.
    const cwd = process.cwd()
    process.chdir(out)
    try {
      const code = await runCli(['scan', fixtureRepo, '--subpath', 'nope'], cap.io)

      expect(code).toBe(1)
      expect(cap.out).toBe('')
      expect(cap.err).toMatch(/^ana: /)
      expect(cap.err).not.toContain('anatomy:')
    } finally {
      process.chdir(cwd)
    }

    const runs = await readdir(path.join(out, '.ana', 'runs'))
    expect(runs).toHaveLength(1)
    const manifest = await artifact<RunManifest>(path.join(out, '.ana', 'runs'), runs[0] as string, 'manifest')
    expect(manifest.status).toBe('failed')
    expect(existsSync(path.join(out, '.ana', 'runs', runs[0] as string, 'tree'))).toBe(false)
  })

  it('answers --help with the scan usage on stdout and exit 0', async () => {
    const cap = capture()

    const code = await runCli(['scan', '--help'], cap.io)

    expect(code).toBe(0)
    expect(cap.err).toBe('')
    expect(cap.out).toContain('Usage: ana scan')
  })
})

// --- argument grammar, driven by a table ----------------------------------

describe('parseScanArgs', () => {
  const cases: Array<[string[], ScanArgs]> = [
    [['repo'], { help: false, repo: 'repo', options: {} }],
    [
      ['repo', '--ref', 'v1.2.3'],
      { help: false, repo: 'repo', options: { ref: 'v1.2.3' } },
    ],
    [
      ['--subpath', 'src', 'repo'],
      { help: false, repo: 'repo', options: { subpath: 'src' } },
    ],
    [['repo', '--top', '5'], { help: false, repo: 'repo', options: { topK: 5 } }],
    // `--flag=value` is the same grammar as `--flag value`.
    [['repo', '--top=5'], { help: false, repo: 'repo', options: { topK: 5 } }],
    [
      ['repo', '--ref=v2', '--subpath=src/lib', '--top=7'],
      { help: false, repo: 'repo', options: { ref: 'v2', subpath: 'src/lib', topK: 7 } },
    ],
    [['--help'], { help: true }],
    [['repo', '-h'], { help: true }],
  ]

  it.each(cases)('parses %o', (argv, expected) => {
    expect(parseScanArgs(argv)).toStrictEqual(expected)
  })

  it.each([[['repo', '--top']], [['repo', '--top=']], [['repo', '--top=0']]])(
    'rejects %o',
    (argv) => {
      expect(() => parseScanArgs(argv)).toThrow()
    },
  )
})

// --- the pipeline's on-disk contract --------------------------------------

/** Artifact names present in a run directory, sorted; `tree` is not an artifact. */
async function runEntries(out: string, runId: string): Promise<string[]> {
  return (await readdir(path.join(out, runId))).sort()
}

const ARTIFACTS = ['candidates.json', 'manifest.json', 'profile.json', 'scope.json', 'structure.json']

/** A tarball of a small repository, answered by a fetch stand-in. */
function archiveSource() {
  const bytes = gzip(
    tar([
      file('package.json', '{"name":"archive-fixture","main":"src/index.ts"}'),
      file('src/index.ts', 'export class Widget {\n  start(): void {}\n}\n'),
      file('README.md', '# archive fixture\n'),
    ]),
  )
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response(bytes, { status: 200 })
  }) as unknown as typeof fetch
  return {
    url: 'https://example.test/archive-fixture.tar.gz',
    deps: { fetchImpl: impl, now: () => new Date('2026-11-12T00:00:00.000Z') },
    calls,
  }
}

/** `anatomy-acquire-*` directories currently in the temp dir: the download scratch space. */
async function acquireDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('anatomy-acquire-'))
}

describe('scanRepo', () => {
  it('persists scope alongside the other artifacts and marks the run complete', async () => {
    const out = await temporaryDir('ana-scan-')

    const result = await scanRepo(fixtureRepo, { baseDir: out, topK: 5 })

    // `scope` cannot be recomputed once the tree is gone, so it belongs in the run.
    const scope = await artifact<Scope>(out, result.runId, 'scope')
    expect(scope.totals).toStrictEqual(result.scope.totals)
    expect(scope.files).toStrictEqual(result.scope.files)
    expect(await runEntries(out, result.runId)).toStrictEqual(ARTIFACTS)

    const manifest = await artifact<RunManifest>(out, result.runId, 'manifest')
    expect(manifest.status).toBe('complete')
    expect(manifest.completedAt).toEqual(expect.any(String))
  })

  it('reports the local checkout as root, and deletes the tree by default', async () => {
    const out = await temporaryDir('ana-scan-')

    const result = await scanRepo(fixtureRepo, { baseDir: out })

    expect(result.root).toBe(fixtureRepo)
    expect(existsSync(path.join(out, result.runId, 'tree'))).toBe(false)
  })

  it('keeps the tree when keepTree is set', async () => {
    const out = await temporaryDir('ana-scan-')

    const result = await scanRepo(fixtureRepo, { baseDir: out, keepTree: true })

    expect(result.root).toBe(fixtureRepo)
    expect(existsSync(path.join(out, result.runId, 'tree'))).toBe(true)
    // Kept means kept: the artifacts are still complete, and the tree is the
    // means for a later stage to slice evidence out of.
    expect(await readFile(path.join(result.root, 'src', 'scheduler.ts'), 'utf8')).toContain(
      'Scheduler',
    )
  })

  it('marks the run failed and writes no artifacts when a stage throws', async () => {
    const out = await temporaryDir('ana-scan-')

    await expect(scanRepo(fixtureRepo, { baseDir: out, subpath: 'nope' })).rejects.toThrow(
      /subpath/,
    )

    const [runId] = await readdir(out)
    const manifest = await artifact<RunManifest>(out, runId as string, 'manifest')
    // A directory that opened but never finished must not look reportable.
    expect(manifest.status).toBe('failed')
    expect(manifest.completedAt).toBeUndefined()
    expect(await runEntries(out, runId as string)).toStrictEqual(['manifest.json'])
    expect(existsSync(path.join(out, runId as string, 'tree'))).toBe(false)
  })

  it('keeps an earlier complete run complete when a re-scan cannot finish', async () => {
    const out = await temporaryDir('ana-scan-')
    const first = await scanRepo(fixtureRepo, { baseDir: out, topK: 5 })
    const completed = await artifact<RunManifest>(out, first.runId, 'manifest')

    // Occupy the candidates path with a directory: the second scan reopens the
    // same run id, then fails while writing its last artifact.
    const blocked = path.join(out, first.runId, 'candidates.json')
    await rm(blocked, { force: true })
    await mkdir(blocked)

    await expect(scanRepo(fixtureRepo, { baseDir: out, topK: 5 })).rejects.toThrow(/complete/)

    // The earlier run is still the last thing that worked; it is neither deleted
    // nor downgraded to `failed`.
    expect(await artifact<RunManifest>(out, first.runId, 'manifest')).toStrictEqual(completed)
  })

  it('scans an archive source, drops the tree and cleans the download directory', async () => {
    const out = await temporaryDir('ana-scan-')
    const archive = archiveSource()
    const before = await acquireDirs()

    const result = await scanRepo(archive.url, { baseDir: out, deps: archive.deps })

    expect(archive.calls).toEqual([archive.url])
    expect(await runEntries(out, result.runId)).toStrictEqual(ARTIFACTS)
    expect(existsSync(path.join(out, result.runId, 'tree'))).toBe(false)
    // The download scratch directory is not the run: nothing of it survives.
    expect(await acquireDirs()).toStrictEqual(before)
  })

  it('keeps the extracted archive tree readable with keepTree', async () => {
    const out = await temporaryDir('ana-scan-')
    const archive = archiveSource()

    const result = await scanRepo(archive.url, {
      baseDir: out,
      deps: archive.deps,
      keepTree: true,
    })

    expect(result.root).toBe(path.join(out, result.runId, 'tree'))
    expect(await readFile(path.join(result.root, 'src', 'index.ts'), 'utf8')).toContain('Widget')
  })
})
