/**
 * The writing layer spends the product's tokens and is the only place untrusted
 * text enters. These tests pin two things at once: the prompt shows only what
 * the model needs (and never pretends an elided line is readable), and every
 * reply is treated as a claim that must survive shape checking, a single repair
 * retry, and Task 10's validator before it reaches `points`.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Counts canonicalizations. The judge's rule is "one decode per file per run",
 * so the spy delegates to the real implementation and only records.
 */
const canonicalCalls = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('../src/kernel/canonicalize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kernel/canonicalize.js')>()
  return {
    ...actual,
    canonicalizeFile: (absPath: string) => {
      canonicalCalls.paths.push(absPath)
      return actual.canonicalizeFile(absPath)
    },
  }
})

import type { Candidate, Scope, Slice } from '../src/contracts/types.js'
import type { ModelClient, ModelRequest } from '../src/writing/client.js'
import {
  DEFAULT_BASE_URL,
  MissingCredentialsError,
  ModelReplyError,
  ModelRequestError,
  buildRequest,
  createModelClient,
} from '../src/writing/client.js'
import { buildJudgePrompt, judgeCandidates } from '../src/writing/judge.js'

// --- fixture tree ---------------------------------------------------------

const root = mkdtempSync(path.join(tmpdir(), 'anatomy-judge-'))
const outside = mkdtempSync(path.join(tmpdir(), 'anatomy-judge-outside-'))
mkdirSync(path.join(root, 'src'), { recursive: true })

const A_TS = [
  '// candidate fixture',
  "import { helper } from './b.js'",
  "import fs from 'node:fs'",
  '',
  'export const LIMIT = 3',
  '',
  'export function pad(value: string): string {',
  "  return value.padStart(LIMIT, '0')",
  '}',
  '',
  '/** Doubles a number. */',
  'export function compute(n: number): number {',
  '  return helper(n) * 2',
  '}',
  '',
  'export function unused(n: number): number {',
  '  return n - 1',
  '}',
  '',
].join('\n')
writeFileSync(path.join(root, 'src', 'a.ts'), A_TS)

const B_LINES = [
  'export function helper(n: number): number {',
  '  return n + 1',
  '}',
]
while (B_LINES.length < 40) B_LINES.push(`export const b${B_LINES.length + 1} = ${B_LINES.length + 1}`)
writeFileSync(path.join(root, 'src', 'b.ts'), `${B_LINES.join('\n')}\n`)

writeFileSync(path.join(root, 'src', 'c.ts'), 'export const neverImported = true\n')

// A candidate near the top of a file wide enough that line 200 is far outside
// any sane window: what the model is not shown must not reach the prompt.
const WIDE_LINES = Array.from({ length: 260 }, (_, i) => `const wide${i + 1} = ${i + 1}`)
WIDE_LINES[11] = 'export function wide(n: number): number {'
WIDE_LINES[12] = '  return n * 3'
WIDE_LINES[13] = '}'
WIDE_LINES[199] = "const NEVER_SHOWN = 'sentinel-200'"
writeFileSync(path.join(root, 'src', 'wide.ts'), `${WIDE_LINES.join('\n')}\n`)

// A file the analysed tree must never send to the provider, and two ways to
// reach it: an import specifier that resolves to a symlink, and a candidate
// whose own path is that symlink.
writeFileSync(path.join(outside, 'credentials.ts'), "const AKIA_SENTINEL = 'AKIA-DO-NOT-SEND'\n")
symlinkSync(path.join(outside, 'credentials.ts'), path.join(root, 'src', 'leak.ts'))
writeFileSync(
  path.join(root, 'src', 'importer.ts'),
  "import { x } from './leak.js'\nexport const importerValue = 1\n",
)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const c1: Candidate = {
  id: 'sig-1',
  path: 'src/a.ts',
  line: 12,
  kind: 'abstraction',
  score: 0.82,
  matched: ['helper', 'doubling'],
}

const c2: Candidate = {
  id: 'sig-2',
  path: 'src/wide.ts',
  line: 12,
  kind: 'complexity',
  score: 0.4,
  matched: [],
}

const scopeOf = (paths: string[]): Scope => ({
  root,
  files: paths.map((filePath) => ({ path: filePath, bytes: 16, lines: 1, language: 'ts' })),
  excluded: [],
  totals: { files: paths.length, bytes: 16 * paths.length, lines: paths.length },
  byLanguage: { ts: paths.length },
})

const SCOPED = scopeOf(['src/a.ts', 'src/b.ts', 'src/wide.ts'])

// --- fake model client ----------------------------------------------------

type Usage = { in: number; out: number }
type Turn = { json?: unknown; error?: Error; usage?: Usage }

type ScriptedClient = ModelClient & { calls: ModelRequest[] }

function scriptedClient(turns: Turn[]): ScriptedClient {
  const calls: ModelRequest[] = []
  let index = 0
  return {
    calls,
    complete: async (req) => {
      calls.push(req)
      const turn = turns[Math.min(index, turns.length - 1)] as Turn
      index += 1
      if (turn.error !== undefined) throw turn.error
      return { json: turn.json, usage: turn.usage ?? { in: 0, out: 0 } }
    },
  }
}

/** A well-formed point whose evidence is the `compute` function at 12..14. */
function goodPoint(): Record<string, unknown> {
  return {
    id: 'p1',
    title: 'compute() delegates doubling to a helper',
    kind: 'algorithm',
    problem: { constraint: 'the doubling rule is single-sourced', stakes: 'two copies drift' },
    alternatives: [{ approach: 'inline n * 2', cost: 'duplicated arithmetic' }],
    theirs: {
      summary: 'a thin compute() over helper()',
      evidence: [
        {
          path: 'src/a.ts',
          startLine: 12,
          endLine: 14,
          snippet:
            'export function compute(n: number): number {\n  return helper(n) * 2\n}',
        },
      ],
    },
    mechanism: 'compute() keeps its name while helper() owns the arithmetic',
    tradeoffs: [{ cost: 'one more hop to read', whenItHurts: 'when debugging a bad number' }],
    confidence: 'high',
    unknowns: [],
    recipe: { prereqs: [], minimalForm: 'return helper(n) * 2', avoidWhen: ['the rule differs'] },
  }
}

// --- fake HTTP ------------------------------------------------------------

type FetchTurn = { body?: unknown; status?: number; text?: string; error?: Error }

function scriptedFetch(...turns: FetchTurn[]): {
  impl: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
  get count(): number
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let index = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const turn = turns[Math.min(index, turns.length - 1)] as FetchTurn
    index += 1
    if (turn.error !== undefined) throw turn.error
    return new Response(turn.text ?? JSON.stringify(turn.body ?? {}), {
      status: turn.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls, get count() { return index } }
}

const openAiReply = (content: unknown, usage = { prompt_tokens: 11, completion_tokens: 7 }) => ({
  choices: [
    {
      message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
    },
  ],
  usage,
})

const req: ModelRequest = { system: 's', user: 'u', schema: { type: 'object' } }

beforeEach(() => {
  canonicalCalls.paths.length = 0
  // A developer machine with a real key must not make these tests hit a network.
  vi.stubEnv('ANA_API_KEY', '')
  vi.stubEnv('ANA_MODEL', '')
  vi.stubEnv('ANA_BASE_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// --- prompt ---------------------------------------------------------------

describe('buildJudgePrompt', () => {
  const slice = (over: Partial<Slice> = {}): Slice => ({
    path: 'src/a.ts',
    startLine: 12,
    endLine: 20,
    text: 'export function compute(n: number): number {\n  return helper(n) * 2\n}',
    truncated: false,
    omitted: null,
    ...over,
  })

  it('labels the candidate and every slice with path:startLine-endLine', () => {
    const { user } = buildJudgePrompt(c1, [slice()], 'zh')

    expect(user).toContain('src/a.ts:12')
    expect(user).toContain('src/a.ts:12-20')
    expect(user).toContain('12 | export function compute(n: number): number {')
    expect(user).toContain('14 | }')
  })

  it('states the schema, the language and the verbatim-citation rule', () => {
    const zh = buildJudgePrompt(c1, [slice()], 'zh').system
    expect(zh).toContain('"theirs"')
    expect(zh).toContain('"confidence"')
    expect(zh).toContain('逐字')
    expect(zh).toMatch(/行号/)

    const en = buildJudgePrompt(c1, [slice()], 'en').system
    expect(en).toContain('verbatim')
    expect(en).toContain('"snippet"')
  })

  it('numbers lines from the slice mapping, not by counting text lines', () => {
    const truncated = slice({
      path: 'src/x.ts',
      startLine: 1,
      endLine: 200,
      text: 'const head = 1\nconst head2 = 2\n...\nconst tail = 9\nconst tail2 = 10',
      truncated: true,
      omitted: { startLine: 3, endLine: 198 },
    })

    const { user } = buildJudgePrompt(c1, [truncated], 'zh')

    expect(user).toContain('src/x.ts:1-200')
    expect(user).toContain('1 | const head = 1')
    expect(user).toContain('2 | const head2 = 2')
    // Tail lines keep their real numbers even though only five text lines exist.
    expect(user).toContain('199 | const tail = 9')
    expect(user).toContain('200 | const tail2 = 10')
    expect(user).not.toMatch(/^\s*4 \| const tail/m)
    // The elided range is stated as unreadable and never rendered as code.
    expect(user).toMatch(/3-198/)
    expect(user).toMatch(/不可读|elided/)
    expect(user).not.toMatch(/^3 \|/m)
  })
})

// --- request building -----------------------------------------------------

describe('buildRequest', () => {
  it('builds an OpenAI-compatible JSON-mode request without leaking the key', () => {
    const built = buildRequest(req, {
      model: 'm1',
      baseUrl: 'https://example.test/v1/',
      apiKey: 'secret-key',
    })

    expect(built.url).toBe('https://example.test/v1/chat/completions')
    expect(built.init.method).toBe('POST')
    expect(built.init.headers['content-type']).toBe('application/json')
    expect(built.init.headers.authorization).toBe('Bearer secret-key')

    const body = JSON.parse(built.init.body) as Record<string, unknown>
    expect(body['model']).toBe('m1')
    expect(body['response_format']).toEqual({ type: 'json_object' })
    expect(body['messages']).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ])
    expect(built.init.body).not.toContain('secret-key')
  })

  it('uses the documented default base URL', () => {
    const built = buildRequest(req, { model: 'm', baseUrl: DEFAULT_BASE_URL, apiKey: 'k' })
    expect(built.url).toBe('https://api.openai.com/v1/chat/completions')
  })
})

// --- model client ---------------------------------------------------------

describe('createModelClient', () => {
  it('throws MissingCredentialsError at call time, not construction', async () => {
    const fetchImpl = scriptedFetch({ body: openAiReply({ ok: true }) })
    const client = createModelClient({ fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).rejects.toBeInstanceOf(MissingCredentialsError)
    expect(fetchImpl.count).toBe(0)
  })

  it('reads ANA_API_KEY and friends at call time', async () => {
    vi.stubEnv('ANA_API_KEY', 'env-key')
    vi.stubEnv('ANA_MODEL', 'env-model')
    vi.stubEnv('ANA_BASE_URL', 'https://env.test/v1')
    const fetchImpl = scriptedFetch({ body: openAiReply({ ok: true }) })

    const client = createModelClient({ fetchImpl: fetchImpl.impl, retryDelayMs: 0 })
    await client.complete(req)

    expect(fetchImpl.calls[0]?.url).toBe('https://env.test/v1/chat/completions')
    expect(fetchImpl.calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer env-key',
    })
    expect(JSON.parse(String(fetchImpl.calls[0]?.init?.body))).toMatchObject({
      model: 'env-model',
    })
  })

  it('parses the content JSON and maps usage', async () => {
    const fetchImpl = scriptedFetch({ body: openAiReply({ title: 't' }) })
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    const reply = await client.complete(req)

    expect(reply.json).toEqual({ title: 't' })
    expect(reply.usage).toEqual({ in: 11, out: 7 })
  })

  it('tolerates a Markdown code fence around the JSON', async () => {
    const fetchImpl = scriptedFetch({ body: openAiReply('```json\n{"a":1}\n```') })
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).resolves.toMatchObject({ json: { a: 1 } })
  })

  it('reports a non-JSON content body as a malformed reply, not a transport error', async () => {
    const fetchImpl = scriptedFetch({ body: openAiReply('not json') })
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    const failure = client.complete(req)
    await expect(failure).rejects.toBeInstanceOf(ModelReplyError)
    await expect(failure).rejects.not.toBeInstanceOf(ModelRequestError)
    // The tokens were spent even though the reply was unusable.
    await expect(failure).rejects.toMatchObject({ usage: { in: 11, out: 7 } })
    expect(fetchImpl.count).toBe(1)
  })

  it('retries a 500 once and succeeds', async () => {
    const fetchImpl = scriptedFetch(
      { status: 500, text: 'boom' },
      { body: openAiReply({ ok: true }) },
    )
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).resolves.toMatchObject({ json: { ok: true } })
    expect(fetchImpl.count).toBe(2)
  })

  it('retries a 429 twice and succeeds on the third attempt', async () => {
    const fetchImpl = scriptedFetch(
      { status: 429, text: 'slow down' },
      { status: 429, text: 'slow down' },
      { body: openAiReply({ ok: true }) },
    )
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).resolves.toMatchObject({ json: { ok: true } })
    expect(fetchImpl.count).toBe(3)
  })

  it('gives up after two retries and surfaces the HTTP status', async () => {
    const fetchImpl = scriptedFetch({ status: 500, text: 'boom' })
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    const failure = client.complete(req)
    await expect(failure).rejects.toBeInstanceOf(ModelRequestError)
    await expect(failure).rejects.toMatchObject({ retryable: true, status: 500 })
    await expect(failure).rejects.toThrow(/HTTP 500/)
    expect(fetchImpl.count).toBe(3)
  })

  it('does not retry a 400', async () => {
    const fetchImpl = scriptedFetch({ status: 400, text: 'bad request' })
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).rejects.toMatchObject({ retryable: false, status: 400 })
    expect(fetchImpl.count).toBe(1)
  })

  it('retries a network error and succeeds', async () => {
    const fetchImpl = scriptedFetch(
      { error: new TypeError('fetch failed') },
      { body: openAiReply({ ok: true }) },
    )
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).resolves.toMatchObject({ json: { ok: true } })
    expect(fetchImpl.count).toBe(2)
  })
})

// --- judge ----------------------------------------------------------------

describe('judgeCandidates', () => {
  it('turns one good reply into one validated point', async () => {
    const client = scriptedClient([{ json: goodPoint(), usage: { in: 5, out: 6 } }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c1],
      scope: SCOPED,
    })

    expect(judged.points).toHaveLength(1)
    expect(judged.points[0]?.theirs.evidence[0]?.path).toBe('src/a.ts')
    expect(judged.points[0]?.theirs.evidence[0]?.startLine).toBe(12)
    expect(judged.validation.kept).toEqual(judged.points)
    expect(judged.validation.dropped).toEqual([])
    expect(judged.usage).toEqual({ in: 5, out: 6 })
    expect(judged.skipped).toEqual([])
  })

  it('sends only the candidate, its imports and its direct dependencies', async () => {
    const client = scriptedClient([{ json: goodPoint() }])

    await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    const prompt = client.calls[0] as ModelRequest
    expect(prompt.user).toContain('src/a.ts:12')
    expect(prompt.user).toContain('src/b.ts:1')
    expect(prompt.user).toContain('export function helper(n: number): number {')
    // Not imported, not in any window: it must not reach the prompt.
    expect(prompt.user).not.toContain('neverImported')
    expect(prompt.user).not.toContain('sentinel-200')
    expect(prompt.system).toContain('"snippet"')
  })

  it('retries a malformed JSON reply once and then skips the candidate', async () => {
    const client = scriptedClient([
      { json: 'not json', usage: { in: 1, out: 0 } },
      { json: 'not json', usage: { in: 1, out: 0 } },
    ])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(client.calls).toHaveLength(2)
    expect(judged.points).toEqual([])
    expect(judged.skipped).toHaveLength(1)
    expect(judged.skipped[0]?.candidateId).toBe('sig-1')
    expect(judged.skipped[0]?.reason).toMatch(/JSON/)
    expect(judged.usage.in).toBe(2)
  })

  it('retries a wrong-shaped object once and then skips it', async () => {
    const client = scriptedClient([{ json: { title: 'only a title' } }])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(client.calls).toHaveLength(2)
    expect(judged.points).toEqual([])
    expect(judged.skipped[0]?.reason).toMatch(/kind/)
  })

  it('accepts a JSON string reply as well as an object', async () => {
    const client = scriptedClient([{ json: JSON.stringify(goodPoint()) }])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(judged.points).toHaveLength(1)
  })

  it('retries a client-reported malformed reply and counts the tokens it spent', async () => {
    const client = scriptedClient([
      {
        error: new ModelReplyError('model reply content is not JSON: oops', { in: 3, out: 0 }),
      },
      { json: goodPoint(), usage: { in: 2, out: 4 } },
    ])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(client.calls).toHaveLength(2)
    expect(judged.points).toHaveLength(1)
    expect(judged.usage).toEqual({ in: 5, out: 4 })
  })

  it('treats an explicit skip as a clean outcome, not a malformed reply', async () => {
    const client = scriptedClient([{ json: { skip: true } }])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(client.calls).toHaveLength(1)
    expect(judged.points).toEqual([])
    // The reason is reader-facing prose — it lands in the report's "没看的部分".
    expect(judged.skipped[0]?.reason).toMatch(/没有找到可迁移的决策/)
  })

  it('accepts the repair after one bad shape', async () => {
    const client = scriptedClient([
      { json: { title: 'incomplete' } },
      { json: goodPoint(), usage: { in: 2, out: 3 } },
    ])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(client.calls).toHaveLength(2)
    expect(judged.points).toHaveLength(1)
    // The repair attempt is told what was wrong, but not what to say.
    expect(client.calls[1]?.user).toContain('kind')
  })

  it('defaults a missing confidence to medium', async () => {
    const point = goodPoint()
    delete point['confidence']
    const client = scriptedClient([{ json: point }])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(judged.points[0]?.confidence).toBe('medium')
  })

  it('never lets a high-confidence point escape without evidence', async () => {
    const point = goodPoint()
    point['theirs'] = { summary: 'nothing to show', evidence: [] }
    const client = scriptedClient([{ json: point }])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(judged.points[0]?.confidence).toBe('low')
    expect(judged.validation.downgraded).toHaveLength(1)
  })

  it('drops a fabricated snippet through the validator', async () => {
    const point = goodPoint()
    point['theirs'] = {
      summary: 'invented',
      evidence: [
        {
          path: 'src/a.ts',
          startLine: 12,
          endLine: 14,
          snippet: 'export function compute(n: number): number {\n  return helper(n) * 3\n}',
        },
      ],
    }
    const client = scriptedClient([{ json: point }])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(judged.points).toEqual([])
    expect(judged.validation.dropped).toHaveLength(1)
    expect(judged.validation.dropped[0]?.reason).toMatch(/snippet/)
  })

  it('skips on a transport failure without spending a repair retry', async () => {
    const client = scriptedClient([
      {
        error: new ModelRequestError('model request failed: HTTP 500: boom', {
          retryable: true,
          status: 500,
        }),
      },
    ])

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED })

    expect(client.calls).toHaveLength(1)
    expect(judged.points).toEqual([])
    expect(judged.skipped[0]?.reason).toMatch(/HTTP 500/)
    expect(judged.skipped[0]?.reason).not.toMatch(/JSON/)
  })

  it('propagates MissingCredentialsError instead of skipping every candidate', async () => {
    const client = scriptedClient([{ error: new MissingCredentialsError() }])

    await expect(
      judgeCandidates({ client, root, runId: 'run-1', candidates: [c1], scope: SCOPED }),
    ).rejects.toBeInstanceOf(MissingCredentialsError)
  })

  it('honours limit and reports the candidates it never judged', async () => {
    const good = goodPoint()
    const client = scriptedClient([{ json: good }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c1, c2],
      scope: SCOPED,
      limit: 1,
    })

    expect(client.calls).toHaveLength(1)
    expect(judged.skipped).toHaveLength(1)
    expect(judged.skipped[0]?.candidateId).toBe('sig-2')
    expect(judged.skipped[0]?.reason).toMatch(/limit/)
  })

  it('skips a candidate whose file cannot be read', async () => {
    const client = scriptedClient([{ json: goodPoint() }])
    const missing: Candidate = { ...c1, id: 'sig-3', path: 'src/missing.ts' }

    const judged = await judgeCandidates({ client, root, runId: 'run-1', candidates: [missing], scope: SCOPED })

    expect(client.calls).toEqual([])
    expect(judged.skipped).toHaveLength(1)
    expect(judged.skipped[0]?.reason).toMatch(/read/)
  })
})

// --- evidence must be within what the prompt showed -------------------------

/** A well-formed point whose evidence is supplied by the test. */
function pointCiting(evidence: Array<Record<string, unknown>>): Record<string, unknown> {
  const point = goodPoint()
  point['theirs'] = { summary: 'cited', evidence }
  return point
}

const SHOWN_WIDE = {
  path: 'src/wide.ts',
  startLine: 12,
  endLine: 14,
  snippet: 'export function wide(n: number): number {\n  return n * 3\n}',
}
const UNSEEN_WIDE = {
  path: 'src/wide.ts',
  startLine: 200,
  endLine: 200,
  snippet: "const NEVER_SHOWN = 'sentinel-200'",
}

describe('judgeCandidates — a citation outside the shown window cannot back a point', () => {
  it('drops the unseen line and keeps the citation the model actually read', async () => {
    const client = scriptedClient([{ json: pointCiting([UNSEEN_WIDE, SHOWN_WIDE]) }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c2],
      scope: SCOPED,
    })

    // The prompt never carried line 200, so no claim may rest on it.
    expect(client.calls[0]?.user).not.toContain('NEVER_SHOWN')
    expect(judged.points).toHaveLength(1)
    expect(judged.points[0]?.theirs.evidence.map((item) => item.startLine)).toEqual([12])
    expect(judged.points[0]?.theirs.evidence[0]?.snippet).toBe(SHOWN_WIDE.snippet)
  })

  it('downgrades a point whose only evidence is a real snippet on an unread line', async () => {
    const client = scriptedClient([{ json: pointCiting([UNSEEN_WIDE]) }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c2],
      scope: SCOPED,
    })

    // The snippet exists on disk and would verify; it is still not evidence the
    // model could have read, so Task 10 sees a point with nothing to back it.
    expect(judged.points).toHaveLength(1)
    expect(judged.points[0]?.theirs.evidence).toEqual([])
    expect(judged.points[0]?.confidence).toBe('low')
    expect(judged.validation.dropped).toEqual([])
    expect(judged.validation.downgraded).toHaveLength(1)
  })
  it('rejects a reversed range at the window gate instead of letting it fail closed later', async () => {
    // 15..13 sits inside the shown window in both bounds, so a gate that only
    // compares bounds one way accepts it; the citation is nonsense either way.
    const reversed = { path: 'src/wide.ts', startLine: 15, endLine: 13, snippet: SHOWN_WIDE.snippet }
    const client = scriptedClient([{ json: pointCiting([reversed]) }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c2],
      scope: SCOPED,
    })

    expect(judged.points).toHaveLength(1)
    expect(judged.points[0]?.theirs.evidence).toEqual([])
    expect(judged.points[0]?.confidence).toBe('low')
    // Task 10 never sees it: the point survives unbacked rather than dying on a
    // range the judge could already tell was impossible.
    expect(judged.validation.dropped).toEqual([])
  })
})

// --- one decode per file per run -------------------------------------------

describe('judgeCandidates — slices come from one decode per file', () => {
  it('canonicalizes each file once even when several candidates share it', async () => {
    const client = scriptedClient([{ json: { skip: true } }])
    const second: Candidate = { ...c1, id: 'sig-1b', line: 16 }

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c1, second],
      scope: SCOPED,
    })

    expect(judged.skipped).toHaveLength(2)
    expect(client.calls).toHaveLength(2)
    expect(canonicalCalls.paths.map((filePath) => path.basename(filePath))).toEqual([
      'a.ts',
      'b.ts',
    ])
  })
})

// --- containment is decided on the real path -------------------------------

describe('judgeCandidates — out-of-tree bytes never reach the provider', () => {
  const importer: Candidate = {
    id: 'sig-sym',
    path: 'src/importer.ts',
    line: 2,
    kind: 'abstraction',
    score: 0.5,
    matched: [],
  }

  it('does not read a dependency that resolves through a symlink out of the root', async () => {
    const client = scriptedClient([{ json: { skip: true } }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [importer],
      scope: scopeOf(['src/importer.ts']),
    })

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.user).not.toContain('AKIA-DO-NOT-SEND')
    expect(canonicalCalls.paths.some((filePath) => filePath.includes(outside))).toBe(false)
    expect(judged.skipped).toHaveLength(1)
  })

  it('skips a candidate whose own path is a symlink out of the root', async () => {
    const client = scriptedClient([{ json: { skip: true } }])
    const leak: Candidate = { ...c1, id: 'sig-leak', path: 'src/leak.ts' }

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [leak],
      scope: scopeOf(['src/leak.ts']),
    })

    expect(client.calls).toEqual([])
    expect(canonicalCalls.paths.some((filePath) => filePath.includes(outside))).toBe(false)
    expect(judged.skipped).toHaveLength(1)
    expect(judged.skipped[0]?.reason).toMatch(/outside/)
  })
})

// --- root and scope are resolved once -------------------------------------

describe('judgeCandidates — the analysed root and scope bound the slices', () => {
  it('keeps dependency slices when the root is spelled "."', async () => {
    const client = scriptedClient([{ json: { skip: true } }])
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    try {
      await judgeCandidates({ client, root: '.', runId: 'run-1', candidates: [c1] })
    } finally {
      cwd.mockRestore()
    }

    expect(client.calls[0]?.user).toContain('src/b.ts:1')
  })

  it('never shows a dependency the scope excluded', async () => {
    const client = scriptedClient([{ json: { skip: true } }])

    await judgeCandidates({
      client,
      root,
      runId: 'run-1',
      candidates: [c1],
      scope: scopeOf(['src/a.ts']),
    })

    expect(client.calls[0]?.user).toContain('src/a.ts:12')
    expect(client.calls[0]?.user).not.toContain('export function helper')
  })
})

// --- evidence ids name the run --------------------------------------------

describe('judgeCandidates — ids name the caller run', () => {
  it('mints evidence ids from the required run id', async () => {
    const client = scriptedClient([{ json: goodPoint() }])

    const judged = await judgeCandidates({
      client,
      root,
      runId: 'run-7',
      candidates: [c1],
      scope: SCOPED,
    })

    expect(judged.points[0]?.theirs.evidence[0]?.id).toMatch(/^run-7-[0-9a-f]{6}$/)
  })
})

// --- request deadlines and provider bodies --------------------------------

describe('createModelClient — deadlines and error bodies', () => {
  it('sends an abort signal with every request', async () => {
    const fetchImpl = scriptedFetch({ body: openAiReply({ ok: true }) })
    const client = createModelClient({
      apiKey: 'k',
      fetchImpl: fetchImpl.impl,
      retryDelayMs: 0,
      timeoutMs: 5_000,
    })

    await client.complete(req)

    expect(fetchImpl.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('treats a stalled request as a retryable timeout instead of hanging forever', async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal === undefined || signal === null) return
        const fail = () => reject(signal.reason ?? new Error('aborted'))
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail)
      })
    }) as unknown as typeof fetch
    const client = createModelClient({
      apiKey: 'k',
      fetchImpl: hanging,
      maxRetries: 0,
      retryDelayMs: 0,
      timeoutMs: 10,
    })

    const failure = client.complete(req)
    await expect(failure).rejects.toBeInstanceOf(ModelRequestError)
    await expect(failure).rejects.toMatchObject({ retryable: true, status: null })
    await expect(failure).rejects.toThrow(/timed out/)
  })

  it('retries an AbortError from the provider instead of failing the run', async () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const fetchImpl = scriptedFetch({ error: aborted }, { body: openAiReply({ ok: true }) })
    const client = createModelClient({ apiKey: 'k', fetchImpl: fetchImpl.impl, retryDelayMs: 0 })

    await expect(client.complete(req)).resolves.toMatchObject({ json: { ok: true } })
    expect(fetchImpl.count).toBe(2)
  })

  it('retries when the deadline fires while the body is being read', async () => {
    // The provider answered with headers and then stalled the body: the abort
    // reaches us from `response.json()`, which is a transport failure, not a
    // bad reply, so it must spend the retry budget instead of ending the run.
    const stalled = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    })
    let index = 0
    const fetchImpl = (async (_input: string | URL | Request, _init?: RequestInit) => {
      index += 1
      if (index === 1) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.reject(stalled),
        } as unknown as Response
      }
      return new Response(JSON.stringify(openAiReply({ ok: true })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const client = createModelClient({
      apiKey: 'k',
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 0,
    })

    await expect(client.complete(req)).resolves.toMatchObject({ json: { ok: true } })
    expect(index).toBe(2)
  })

  it('surfaces a stalled body as a retryable transport error, not a malformed reply', async () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.reject(aborted),
      }) as unknown as Response) as unknown as typeof fetch
    const client = createModelClient({
      apiKey: 'k',
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 0,
      timeoutMs: 10,
    })

    const failure = client.complete(req)
    await expect(failure).rejects.toBeInstanceOf(ModelRequestError)
    await expect(failure).rejects.not.toBeInstanceOf(ModelReplyError)
    await expect(failure).rejects.toMatchObject({ retryable: true })
  })

  it('keeps the provider status but never copies its error body into the failure', async () => {
    const fetchImpl = scriptedFetch({ status: 500, text: 'sk-live-provider-token leaked' })
    const client = createModelClient({
      apiKey: 'k',
      fetchImpl: fetchImpl.impl,
      maxRetries: 0,
      retryDelayMs: 0,
    })

    const failure = client.complete(req)
    await expect(failure).rejects.toMatchObject({ status: 500 })
    await expect(failure).rejects.toThrow(/HTTP 500/)
    await expect(failure).rejects.not.toThrow(/sk-live-provider-token/)
  })
})
