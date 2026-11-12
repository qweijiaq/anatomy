/**
 * `ana analyze` is the only command that spends tokens, and the only one whose
 * failures are silent: a run that judged nothing still renders a report.
 *
 * So these tests drive the whole pipeline with a fake client and no API key, and
 * they check the things a passing unit test would not notice — that the rendered
 * page names the repository and carries real trust numbers, that the skipped
 * list accounts for every candidate the run did not look at, and that the
 * extract tree is gone after the artifacts are on disk while the artifacts stay.
 *
 * The fake client reads the prompt it was handed instead of being scripted: it
 * cites the line numbers and text the judge actually showed it, which is the
 * only way a citation survives both the "was this line shown" check and the
 * "is this snippet verbatim" check downstream.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runAnalyze } from '../src/commands/analyze.js'
import type { LearningPoint } from '../src/contracts/types.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/writing/client.js'

// --- fixture repository ---------------------------------------------------

const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** A scratch directory that is removed when the file finishes. */
function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/**
 * A four-file repository whose signals are known: two decision traces and three
 * hand-written wheels, spread over four files, so the run has several candidates
 * to keep, cut and rank.
 */
function fixtureRepo(): string {
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

type FakeClient = ModelClient & { calls: Array<{ system: string; user: string }> }

/**
 * Answers every request without a network call: the judge gets a point citing a
 * line it really was shown, the synthesiser gets a subset of the titles it was
 * really offered. Nothing is scripted per candidate, so the fake works for any
 * budget and either language.
 */
function fakeClient(): FakeClient {
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

// --- reading a finished run -----------------------------------------------

async function artifact<T>(baseDir: string, runId: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(baseDir, runId, `${name}.json`), 'utf8')) as T
}

const runPath = (baseDir: string, runId: string, name: string): string =>
  path.join(baseDir, runId, name)

// --- the run --------------------------------------------------------------

describe('runAnalyze', () => {
  it('writes a report that names the repository and its trust numbers', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    const result = await runAnalyze(repo, { baseDir, client: fakeClient() })

    expect(result.runId).not.toBe('')
    expect(result.reportPath).toBe(runPath(baseDir, result.runId, 'report.md'))
    expect(existsSync(result.reportPath)).toBe(true)

    const markdown = await readFile(result.reportPath, 'utf8')
    // The heading is the directory the reader typed, not the whole temp path.
    expect(markdown.startsWith('# fixture-repo\n')).toBe(true)
    expect(markdown).toContain('## 这次分析的可信度')
    expect(markdown).toMatch(/已取证点占比：\d+\.\d%/)
    expect(markdown).toMatch(/每点平均证据数：\d/)

    // Every artifact the run claims to have produced is on disk.
    for (const name of [
      'report.json',
      'points.json',
      'validation.json',
      'synthesis.json',
      'skipped.json',
    ]) {
      expect(existsSync(runPath(baseDir, result.runId, name)), name).toBe(true)
    }
  })

  it('deletes the extracted tree and keeps the artifacts', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    const result = await runAnalyze(repo, { baseDir, client: fakeClient() })

    expect(existsSync(runPath(baseDir, result.runId, 'tree'))).toBe(false)
    expect(existsSync(runPath(baseDir, result.runId, 'report.md'))).toBe(true)
    expect(existsSync(runPath(baseDir, result.runId, 'points.json'))).toBe(true)
    // The analysed repository itself is the user's, not the run's to delete.
    expect(existsSync(path.join(repo, 'src', 'scheduler.ts'))).toBe(true)
  })

  it('reports the candidates a small budget cut, in the artifact and in the tail', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()
    // Enough for one or two candidates: the point is the cut, not the report.
    const budget = 7_000

    const result = await runAnalyze(repo, { baseDir, client: fakeClient(), budget })

    const skipped = await artifact<Array<{ path: string; line: number; reason: string }>>(
      baseDir,
      result.runId,
      'skipped',
    )
    const cut = skipped.filter((entry) => entry.reason === 'cut by token budget')
    expect(cut.length).toBeGreaterThan(0)
    expect(cut.every((entry) => entry.path !== '' && entry.line > 0)).toBe(true)
    // The cut is not the whole list: the synthesis outcome is declared too.
    expect(skipped.length).toBeGreaterThan(cut.length)
    // A cut budget, not a fatal one: something still got judged and reported.
    const points = await artifact<LearningPoint[]>(baseDir, result.runId, 'points')
    expect(points.length).toBeGreaterThan(0)

    const markdown = await readFile(result.reportPath, 'utf8')
    expect(markdown).toContain('## 没看的部分')
    expect(markdown).toContain(`${cut.length} candidates cut by token budget`)
    for (const entry of cut) expect(markdown).toContain(`${entry.path}:${entry.line}`)
  })

  it('keeps points that cite the real fixture lines, and shows the citation', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    const result = await runAnalyze(repo, { baseDir, client: fakeClient() })

    const points = await artifact<LearningPoint[]>(baseDir, result.runId, 'points')
    expect(points.length).toBeGreaterThan(0)

    for (const point of points) {
      const [evidence] = point.theirs.evidence
      if (evidence === undefined) throw new Error(`${point.id} reached points.json with no evidence`)
      const lines = (await readFile(path.join(repo, evidence.path), 'utf8')).split('\n')
      expect(lines[evidence.startLine - 1]).toBe(evidence.snippet)
    }

    const [first] = points[0]?.theirs.evidence ?? []
    if (first === undefined) throw new Error('no evidence to check in the report')
    const markdown = await readFile(result.reportPath, 'utf8')
    expect(markdown).toContain(`${first.path}:${first.startLine}-${first.endLine}`)
  })

  it('produces a report with lang en, switching only the prompts', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()
    const client = fakeClient()

    const result = await runAnalyze(repo, { baseDir, client, lang: 'en' })

    const markdown = await readFile(result.reportPath, 'utf8')
    expect(markdown.startsWith('# fixture-repo\n')).toBe(true)
    expect(markdown.length).toBeGreaterThan(0)

    // The switch is a prompt switch: the judge and the synthesiser asked in English.
    expect(client.calls[0]?.system).toContain('You are the reader')
    expect(client.calls.some((call) => call.system.includes('synthesiser'))).toBe(true)
  })
})
