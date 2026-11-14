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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { normaliseExcerpt, providerRefusal, resolveModelName, runAnalyze, synthesisGap } from '../src/commands/analyze.js'
import { DEFAULT_MODEL } from '../src/writing/client.js'
import type { LearningPoint, RunManifest } from '../src/contracts/types.js'
import type { AcquireDeps } from '../src/kernel/acquire.js'
import type { Run } from '../src/store/runs.js'
import {
  MissingCredentialsError,
  ModelRequestError,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/writing/client.js'

/**
 * Lets one test make the end-of-run cleanup fail, which is the only way to reach
 * a cleanup failure without a filesystem that refuses `rm`.
 *
 * Only the analyze-level call is refused: the scan's own call carries `keepTree`,
 * is a no-op, and must keep working, so the default factory delegates to the real
 * `closeRun` for everything else.
 */
const closeControl = vi.hoisted(() => ({ fail: false }))

vi.mock('../src/store/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store/runs.js')>()
  return {
    ...actual,
    async closeRun(run: Run, opts: { keepTree?: boolean } = {}): Promise<void> {
      if (closeControl.fail && opts.keepTree !== true) {
        throw Object.assign(new Error('EPERM: operation not permitted, rm tree'), { code: 'EPERM' })
      }
      return actual.closeRun(run, opts)
    },
  }
})

// --- fixture repository ---------------------------------------------------

const created: string[] = []

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  closeControl.fail = false
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

/**
 * A client that dies on the first request. `MissingCredentialsError` is the one
 * failure the judge does not turn into a skipped candidate, so it is the only
 * way to make the whole run throw without a scripted reply.
 */
function failingClient(error: Error): ModelClient {
  return {
    async complete(): Promise<ModelResponse> {
      throw error
    },
  }
}

const runPath = (baseDir: string, runId: string, name: string): string =>
  path.join(baseDir, runId, name)

/** The title of the point the client below submits with no citation at all. */
const UNSOURCED_TITLE = '没有证据的猜测'

/**
 * Judges the first candidate with a point that cites nothing.
 *
 * The reply is shape-valid, so nothing is retried: the point survives validation
 * as a downgraded zero-evidence point — present in `points.json`, withheld from
 * the page as `notRendered`. That is the case the TOP list must not be told
 * about.
 */
function partlyUnsourcedClient(): FakeClient {
  const inner = fakeClient()
  let stated = false

  return {
    calls: inner.calls,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      // The synthesis prompt is the one with no `path:line` slice in it.
      if (stated || citedLines(request.user).length === 0) return inner.complete(request)
      stated = true
      inner.calls.push({ system: request.system, user: request.user })
      return {
        json: {
          id: 'fixture-unsourced',
          title: UNSOURCED_TITLE,
          kind: 'algorithm',
          problem: { constraint: '没有约束', stakes: '没有代价' },
          alternatives: [{ approach: '凭直觉', cost: '说不出为什么' }],
          theirs: { summary: '我猜是这样。', evidence: [] },
          mechanism: '猜的。',
          tradeoffs: [{ cost: '不能核对', whenItHurts: '读者去查的时候' }],
          confidence: 'medium',
          unknowns: [],
          recipe: null,
        },
        usage: { in: 1, out: 1 },
      }
    },
  }
}

/**
 * Answers every judge call, then fails the synthesis request with a 5xx.
 *
 * The judge prompt always carries a slice; the synthesis prompt never does, so
 * "no cited lines" is the last stage of the run.
 */
function failingSynthesisClient(inner: FakeClient): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (citedLines(request.user).length === 0) {
        throw new ModelRequestError('upstream answered HTTP 500', {
          retryable: false,
          status: 500,
        })
      }
      return inner.complete(request)
    },
  }
}

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
    // The heading is the recognisable name of the input the reader gave; the
    // exact source is restated in the 口径 block, where it is evidence.
    expect(markdown.startsWith(`# ${path.basename(repo)}\n`)).toBe(true)
    expect(markdown).toContain(`- 来源：${repo}`)
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

  it('produces an English report with lang en, frame and prompts alike', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()
    const client = fakeClient()

    const result = await runAnalyze(repo, { baseDir, client, lang: 'en' })

    const markdown = await readFile(result.reportPath, 'utf8')
    expect(markdown.startsWith(`# ${path.basename(repo)}\n`)).toBe(true)
    // The frame follows the language too — it used to stay Chinese, which made
    // `--lang en` an English body under Chinese headings.
    expect(markdown).toContain(`- Source: ${repo}`)
    expect(markdown).toContain('## What this analysis is about')
    expect(markdown.length).toBeGreaterThan(0)

    // And the prompts asked in English: the judge and the synthesiser.
    expect(client.calls[0]?.system).toContain('You are the reader')
    expect(client.calls.some((call) => call.system.includes('synthesiser'))).toBe(true)
  })

  it('offers the synthesiser only the titles the page will show', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()
    const client = partlyUnsourcedClient()

    const result = await runAnalyze(repo, { baseDir, client })

    const points = await artifact<LearningPoint[]>(baseDir, result.runId, 'points')
    const unsourced = points.filter((point) => point.theirs.evidence.length === 0)
    const sourced = points.filter((point) => point.theirs.evidence.length > 0)
    expect(unsourced.length).toBe(1)
    expect(sourced.length).toBeGreaterThan(0)

    // The synthesis request never names the claim the body withholds, and does
    // name every claim it shows.
    const synthesisCall = client.calls.find((call) => citedLines(call.user).length === 0)
    if (synthesisCall === undefined) throw new Error('the run never asked for a synthesis')
    const offered = offeredTitles(synthesisCall.user)
    expect(offered).not.toContain(UNSOURCED_TITLE)
    for (const point of sourced) expect(offered).toContain(point.title)

    // And the page's TOP list names only what the page shows.
    const report = await artifact<{ topFive: string[]; points: Array<{ title: string }> }>(
      baseDir,
      result.runId,
      'report',
    )
    const shown = report.points.map((point) => point.title)
    expect(shown).not.toContain(UNSOURCED_TITLE)
    expect(report.topFive.length).toBeGreaterThan(0)
    for (const title of report.topFive) expect(shown).toContain(title)
  })

  // --- failures -------------------------------------------------------------

  it('keeps a judged run when synthesis fails at the last step', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    const result = await runAnalyze(repo, {
      baseDir,
      client: failingSynthesisClient(fakeClient()),
    })

    // Everything the judging call paid for is on disk...
    const points = await artifact<LearningPoint[]>(baseDir, result.runId, 'points')
    expect(points.length).toBeGreaterThan(0)
    expect(existsSync(runPath(baseDir, result.runId, 'validation.json'))).toBe(true)
    // ...the failure is declared rather than hidden...
    const skipped = await artifact<Array<{ path: string; line: number; reason: string }>>(
      baseDir,
      result.runId,
      'skipped',
    )
    expect(skipped.some((entry) => entry.reason.startsWith('synthesis failed'))).toBe(true)
    expect(skipped.some((entry) => entry.reason.includes('500'))).toBe(true)

    // ...and the page exists, with no invented brief.
    const report = await artifact<{ problem: string; topFive: string[] }>(
      baseDir,
      result.runId,
      'report',
    )
    expect(report.problem).toBe('')
    expect(report.topFive).toEqual([])
    const markdown = await readFile(result.reportPath, 'utf8')
    expect(markdown).toContain('## 这次分析的可信度')
    expect(markdown).toContain('这次没有选出最值得学的条目')

    const manifest = await artifact<RunManifest>(baseDir, result.runId, 'manifest')
    expect(manifest.status).toBe('complete')
  })

  it('refuses a keyless run before it acquires anything', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const fetchImpl = vi.fn()
    const deps: AcquireDeps = {
      fetchImpl: fetchImpl as unknown as NonNullable<AcquireDeps['fetchImpl']>,
    }
    vi.stubEnv('ANA_API_KEY', '')
    const failure = await runAnalyze('https://github.com/owner/repo', { baseDir, deps }).catch(
      (error: unknown) => error,
    )
    vi.unstubAllEnvs()

    // The failure is the client's own, raised before a byte was fetched.
    expect(failure).toBeInstanceOf(MissingCredentialsError)
    expect((failure as Error).message).toContain('ANA_API_KEY')
    expect(fetchImpl).not.toHaveBeenCalled()
    // No run directory either: nothing was opened on the user's behalf.
    expect(readdirSync(baseDir)).toEqual([])
  })

  it('keeps the stage failure when the cleanup also fails', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()
    closeControl.fail = true

    const failure = await runAnalyze(repo, {
      baseDir,
      client: failingClient(new MissingCredentialsError('the judge exploded')),
    }).catch((error: unknown) => error)

    // The reason the run died stays the message; the cleanup failure is attached,
    // not substituted for it, because EPERM says nothing about the real cause.
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('the judge exploded')
    const cause = (failure as Error).cause as Error | undefined
    expect(cause?.message).toContain('EPERM')
  })

  it('leaves no extracted tree behind when the scan itself fails', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    await expect(
      runAnalyze(repo, { baseDir, subpath: 'no-such-directory', client: fakeClient() }),
    ).rejects.toThrow(/no-such-directory/)

    // A run that never produced anything is a run directory with a manifest and
    // no reason to hold a copy of the repository.
    const runIds = readdirSync(baseDir)
    expect(runIds.length).toBeGreaterThan(0)
    for (const runId of runIds) {
      expect(existsSync(path.join(baseDir, runId, 'tree')), runId).toBe(false)
    }
  })

  it('does not persist a credential the provider echoed back', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()
    const inner = fakeClient()
    let first = true
    const echoing: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (first) {
          first = false
          throw new Error('provider echoed GET /v1/messages?api_key=sk-abc123')
        }
        return inner.complete(request)
      },
    }

    const result = await runAnalyze(repo, { baseDir, client: echoing })

    const raw = await readFile(runPath(baseDir, result.runId, 'skipped.json'), 'utf8')
    expect(raw).not.toContain('sk-abc123')
    // Redacted, not deleted: the entry still says what went wrong.
    expect(raw).toContain('provider echoed')
    expect(await readFile(result.reportPath, 'utf8')).not.toContain('sk-abc123')
  })

  it('marks the run complete only once the report is on disk', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    const result = await runAnalyze(repo, { baseDir, client: fakeClient() })

    const manifest = await artifact<RunManifest>(baseDir, result.runId, 'manifest')
    expect(manifest.status).toBe('complete')
    expect(typeof manifest.completedAt).toBe('string')
    expect(existsSync(runPath(baseDir, result.runId, 'report.md'))).toBe(true)
  })

  it('leaves a failed run marked failed, with no completion time', async () => {
    const baseDir = temporaryDir('ana-analyze-out-')
    const repo = fixtureRepo()

    await expect(
      runAnalyze(repo, {
        baseDir,
        client: failingClient(new MissingCredentialsError('no key for this run')),
      }),
    ).rejects.toThrow(/no key for this run/)

    const runIds = readdirSync(baseDir)
    expect(runIds.length).toBeGreaterThan(0)
    for (const runId of runIds) {
      const manifest = await artifact<RunManifest>(baseDir, runId, 'manifest')
      expect(manifest.status).toBe('failed')
      expect(manifest.completedAt).toBeUndefined()
    }
  })
})

describe('which model a run uses', () => {
  /**
   * `--model` > `$ANA_MODEL` > the built-in default, which is what the usage text says
   * and what did not happen. `runAnalyze` resolved the model with
   * `opts.model ?? DEFAULT_MODEL` and passed the result as an explicit value, so the
   * client never consulted the environment: every run used `gpt-4o-mini` no matter
   * what `ANA_MODEL` said.
   *
   * Found by pointing a real run at DeepSeek, which answered HTTP 400 once per
   * candidate — "you passed gpt-4o-mini" — and produced an empty report. No test could
   * see it because tests inject a client and never reach this branch.
   */
  const original = process.env['ANA_MODEL']
  afterEach(() => {
    if (original === undefined) delete process.env['ANA_MODEL']
    else process.env['ANA_MODEL'] = original
  })

  it('prefers the flag', () => {
    process.env['ANA_MODEL'] = 'from-env'
    expect(resolveModelName('from-flag')).toBe('from-flag')
  })

  it('falls back to $ANA_MODEL', () => {
    process.env['ANA_MODEL'] = 'from-env'
    expect(resolveModelName(undefined)).toBe('from-env')
  })

  it('falls back to the built-in default only when nothing else is set', () => {
    delete process.env['ANA_MODEL']
    expect(resolveModelName(undefined)).toBe(DEFAULT_MODEL)
    expect(resolveModelName('')).toBe(DEFAULT_MODEL)
  })
})

describe('the note about points left out of the body', () => {
  /**
   * A real English run had exactly one Chinese line in it: this note. It was built
   * without a language argument, so `--lang en` produced an English page with one
   * Chinese sentence under `skipped:`. The fixture reports never reached it because
   * their synthesiser selects every point, so the "left out" branch never ran.
   */
  const points = ['a', 'b', 'c'].map((title) => ({ title }) as LearningPoint)

  it('speaks English when the run asked for English', () => {
    const text = synthesisGap({ problem: '', topFive: ['a'] } as never, points, 'en')
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(false)
    expect(text).toContain('1 of 3')
    expect(text).toContain('b; c')
  })

  it('speaks Chinese when the run asked for Chinese', () => {
    const text = synthesisGap({ problem: '', topFive: ['a'] } as never, points, 'zh')
    expect(text).toContain('另有 2 个已核实')
    expect(text).toContain('b；c')
  })

  it('says so when every point made it in, in both languages', () => {
    const synthesis = { problem: '', topFive: ['a', 'b', 'c'] } as never
    expect(synthesisGap(synthesis, points, 'en')).toBe('All 3 verified points were written into the report.')
    expect(synthesisGap(synthesis, points, 'zh')).toBe('全部 3 个已核实的点都写进了报告。')
  })
})

describe('a rejected run is not a run that found nothing', () => {
  /**
   * A wrong API key made every judge call fail with HTTP 401, wrote a report with no
   * points, and exited 0. A script cannot tell that from a repository that genuinely
   * holds nothing to learn — the difference only exists if the status survives the run.
   */
  it('keeps the client-error statuses and ignores what was retried', () => {
    expect(providerRefusal([{ status: 401, count: 3 }])).toEqual([{ status: 401, count: 3 }])
    expect(providerRefusal([{ status: 400, count: 1 }, { status: 403, count: 2 }])).toHaveLength(2)
    // 429 and 5xx already went through the client's retry budget; they are a different
    // failure with their own message.
    expect(providerRefusal([{ status: 429, count: 1 }, { status: 503, count: 2 }])).toEqual([])
    expect(providerRefusal([])).toEqual([])
  })

  it('recognises two 401s as one kind of failure', () => {
    // Provider bodies carry a per-request id, so a raw compare printed the same
    // sentence once per candidate.
    const a = '{"error":{"message":"Authentication Fails","request_id":"aca75d39-6441-4b6d-9e0c-9e1e53a85e51"}}'
    const b = '{"error":{"message":"Authentication Fails","request_id":"988d3b64-71e9-45fa-85ed-e62ab5fd9716"}}'
    expect(normaliseExcerpt(a)).toBe(normaliseExcerpt(b))
    expect(normaliseExcerpt(a)).toContain('Authentication Fails')
  })

  it('reports the failure through the run result', async () => {
    const baseDir = temporaryDir('ana-analyze-refused-')
    const repo = fixtureRepo()
    const refused = {
      complete: async () => {
        const error = new ModelRequestError('model request failed: HTTP 401', {
          retryable: false,
          status: 401,
          detail: '{"error":{"message":"Authentication Fails","request_id":"x-1"}}',
        })
        throw error
      },
    }

    const result = await runAnalyze(repo, { baseDir, client: refused as never })
    expect(result.modelFailures).toEqual([{ status: 401, count: 1 }])
  })
})
