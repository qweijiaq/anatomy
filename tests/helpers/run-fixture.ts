/**
 * The fixture the command tests share: a small repository whose signals are
 * known, and a model client that answers without a network call.
 *
 * The fake reads the prompt it was handed instead of being scripted, so it works
 * for any budget and either language: the judge gets a point citing a line it
 * really was shown, the synthesiser a subset of the titles it was really offered.
 * That is the only way a citation survives both the "was this line shown" check
 * and the "is this snippet verbatim" check downstream.
 *
 * `storedRun` is the other half: a run directory written by hand, for the paths
 * that must not run a pipeline at all (an incomplete run, a run that never
 * existed, a second run in the same parent).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Evidence, LearningPoint } from '../../src/contracts/types.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../../src/writing/client.js'

// --- scratch directories --------------------------------------------------

const created: string[] = []

/** A scratch directory, removed when the test file finishes. */
export function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** Removes every scratch directory this file made. Call from `afterAll`. */
export function cleanupTemporaryDirs(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
  created.length = 0
}

// --- fixture repository ---------------------------------------------------

/**
 * A four-file repository whose signals are known: two decision traces and three
 * hand-written wheels, spread over four files, so a run has several candidates
 * to keep, cut and rank.
 */
export function fixtureRepo(): string {
  const repo = path.join(temporaryDir('ana-analyze-'), 'fixture-repo')
  for (const dir of ['src', 'tests']) mkdirSync(path.join(repo, dir), { recursive: true })

  const write = (relative: string, lines: string[]): void => {
    writeFileSync(path.join(repo, relative), lines.join('\n'))
  }

  write('package.json', [JSON.stringify({ name: 'fixture-repo', type: 'module' })])
  write('src/ring.ts', [
    'export class Ring {',
    '  private readonly slots: number[] = []',
    '',
    '  push(value: number): void {',
    '    this.slots.push(value)',
    '  }',
    '}',
    '',
  ])
  write('src/scheduler.ts', [
    "import { Ring } from './ring.js'",
    '',
    '/**',
    ' * We chose a fixed-size ring instead of shifting the array, because a shift',
    ' * is O(n) per push and the ring is there to keep push O(1).',
    ' */',
    'export class JobScheduler {',
    '  private readonly ring = new Ring()',
    '',
    '  push(value: number): boolean {',
    '    this.ring.push(value)',
    '    return true',
    '  }',
    '}',
    '',
  ])
  write('src/cache.ts', [
    '/** Deliberately no TTL here: the caller owns invalidation, because a TTL',
    ' * would hide the stale read instead of reporting it.',
    ' */',
    'export class LruCache {',
    '  private readonly entries = new Map<string, string>()',
    '',
    '  get(key: string): string | null {',
    '    return this.entries.get(key) ?? null',
    '  }',
    '}',
    '',
  ])
  write('src/limiter.ts', [
    'export class TokenBucketLimiter {',
    '  private tokens = 0',
    '',
    '  take(): boolean {',
    '    if (this.tokens === 0) return false',
    '    this.tokens -= 1',
    '    return true',
    '  }',
    '}',
    '',
  ])
  write('src/index.ts', [
    "export * from './scheduler.js'",
    "export * from './cache.js'",
    "export * from './limiter.js'",
    "export * from './ring.js'",
    '',
  ])
  write('tests/scheduler.test.ts', [
    "import { JobScheduler } from '../src/scheduler.js'",
    '',
    'it("keeps push O(1)", () => {',
    '  expect(new JobScheduler().push(1)).toBe(true)',
    '})',
    '',
  ])

  return repo
}

// --- fake model -----------------------------------------------------------

type CitedLine = { path: string; line: number; text: string }

/**
 * The `path:line`-labelled lines of a judge prompt, in the order the model saw
 * them. The slice header carries the path; the number before the `|` is the real
 * file line number. An elided range is dropped: it is the one thing the prompt
 * says is unreadable.
 */
function citedLines(user: string): CitedLine[] {
  const found: CitedLine[] = []
  let current = ''
  for (const raw of user.split('\n')) {
    const header = /^--- (\S+?):(\d+)-(\d+)/.exec(raw)
    if (header !== null) {
      current = header[1] as string
      continue
    }
    const labelled = /^(\d+) \| (.*)$/.exec(raw)
    if (labelled === null || current === '') continue
    const text = labelled[2] as string
    if (text.includes('<<<')) continue
    found.push({ path: current, line: Number(labelled[1]), text })
  }
  return found
}

/** A line worth quoting: long enough, and carrying an identifier. */
function quotable(line: CitedLine): boolean {
  const dense = line.text.replace(/\s+/g, '')
  return dense.length >= 8 && /[A-Za-z0-9]{3,}/.test(dense)
}

/** The numbered titles of a synthesis prompt. */
function offeredTitles(user: string): string[] {
  const titles: string[] = []
  for (const raw of user.split('\n')) {
    const numbered = /^\d+\.\s+(.+)$/.exec(raw.trim())
    if (numbered !== null) titles.push((numbered[1] as string).trim())
  }
  return titles
}

const REPLY_KINDS = [
  'algorithm',
  'performance',
  'architecture',
  'data-model',
  'api-design',
] as const

export type FakeClient = ModelClient & { calls: Array<{ system: string; user: string }> }

/** Answers every request from the prompt it was handed: no network, no script. */
export function fakeClient(): FakeClient {
  const calls: Array<{ system: string; user: string }> = []
  let replies = 0

  return {
    calls,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls.push({ system: request.system, user: request.user })

      const lines = citedLines(request.user)
      if (lines.length === 0) {
        const titles = offeredTitles(request.user)
        return {
          json: { problem: '这个仓库演示了固定容量队列与缓存的取舍。', topFive: titles.slice(0, 5) },
          usage: { in: 1, out: 1 },
        }
      }

      const cited = lines.find(quotable)
      if (cited === undefined) return { json: { skip: true }, usage: { in: 1, out: 1 } }

      replies += 1
      return {
        json: {
          id: `fixture-${replies}`,
          title: `固定容量的取舍 ${cited.path}:${cited.line}`,
          kind: REPLY_KINDS[replies % REPLY_KINDS.length],
          problem: { constraint: '固定容量', stakes: '满了必须明确拒绝' },
          alternatives: [{ approach: '每次扩容', cost: '每次 push 都要搬移' }],
          theirs: {
            summary: '容量固定，满了就返回 false。',
            evidence: [
              { path: cited.path, startLine: cited.line, endLine: cited.line, snippet: cited.text },
            ],
          },
          mechanism: '游标在固定槽位上前进，不做搬移。',
          tradeoffs: [{ cost: '满了会丢一次写入', whenItHurts: '调用方不检查返回值时' }],
          confidence: 'medium',
          unknowns: [],
          recipe: null,
        },
        usage: { in: 1, out: 1 },
      }
    },
  }
}

// --- reading and writing run directories ----------------------------------

/** One artifact of a run, parsed. */
export async function artifact<T>(baseDir: string, runId: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(baseDir, runId, `${name}.json`), 'utf8')) as T
}

export type StoredRunOptions = {
  /** `failed` marks a run that opened and never finished. Defaults to complete. */
  complete?: boolean
  /** The stored point's evidence; `null` (the default) stores no points at all. */
  evidence?: Evidence | null
}

/**
 * A run directory written by hand: the six artifacts `ana report` reads, plus
 * the manifest, with no pipeline and no model behind them.
 *
 * The repository root is `/tmp/demo`, which does not exist — proof that nothing
 * downstream needs the extracted tree.
 */
export function storedRun(
  baseDir: string,
  runId: string,
  opts: StoredRunOptions = {},
): string {
  const dir = path.join(baseDir, runId)
  mkdirSync(dir, { recursive: true })

  const complete = opts.complete ?? true
  const evidence = opts.evidence ?? null

  const manifest = {
    runId,
    // Matches `scope.root` below: a run's source and the directory it analysed
    // are the same project, and the report names it once.
    source: '/tmp/demo',
    ref: 'local',
    sha: 'fixture-sha',
    subpath: '',
    engineVersion: '0.0.1',
    startedAt: '2026-11-12T00:00:00.000Z',
    status: complete ? 'complete' : 'failed',
    ...(complete ? { completedAt: '2026-11-12T00:00:01.000Z' } : {}),
  }
  const scope = {
    root: '/tmp/demo',
    files: [],
    excluded: [],
    totals: { files: 0, bytes: 0, lines: 0 },
    byLanguage: {},
  }
  const profile = {
    languages: {},
    manifests: [],
    entryPoints: [],
    hasTests: false,
    hasCi: false,
    hasDocs: false,
    notes: [],
  }
  const synthesis = { problem: '这个仓库演示了一个取舍。', topFive: complete ? ['一个取舍'] : [] }
  const points: LearningPoint[] =
    evidence === null
      ? []
      : [
          {
            id: 'point-1',
            title: '一个取舍',
            kind: 'architecture',
            problem: { constraint: '固定容量', stakes: '满了必须拒绝' },
            alternatives: [{ approach: '每次扩容', cost: '每次都要搬移' }],
            theirs: { summary: '容量固定。', evidence: [evidence] },
            mechanism: '游标前进。',
            tradeoffs: [{ cost: '会丢一次写入', whenItHurts: '不检查返回值时' }],
            confidence: 'medium',
            unknowns: [],
            recipe: null,
          },
        ]
  const validation = {
    kept: points,
    downgraded: [],
    dropped: [],
    stats: { evidenceRate: 1, droppedEvidence: 0, avgEvidence: points.length },
  }

  const write = (name: string, value: unknown): void => {
    writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
  }
  write('manifest', manifest)
  write('scope', scope)
  write('profile', profile)
  write('synthesis', synthesis)
  write('points', points)
  write('validation', validation)
  write('skipped', [])

  return dir
}
