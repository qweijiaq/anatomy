/**
 * The synthesis stage writes the report's first section: what this repository
 * is for, and which five things are worth learning from it. Two rules keep it
 * honest. It sees the repository's shape and the point titles — never code, so
 * it cannot invent a mechanism no judge verified. And `topFive` is a subset of
 * the titles it was given, so the section can never advertise a point that is
 * not in the report.
 */

import { describe, expect, it } from 'vitest'

import type { Profile, StructureIndex } from '../src/contracts/types.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/writing/client.js'
import {
  EMPTY_CONTENT_MESSAGE,
  MissingCredentialsError,
  ModelReplyError,
  ModelRequestError,
} from '../src/writing/client.js'
import { summarizeStructure, synthesize } from '../src/writing/synthesis.js'

// --- fixtures -------------------------------------------------------------

const profile: Profile = {
  languages: { TypeScript: 120, Python: 8 },
  manifests: ['package.json', 'pyproject.toml'],
  entryPoints: ['src/cli.ts'],
  hasTests: true,
  hasCi: true,
  hasDocs: true,
  notes: ['a python sidecar does the parsing'],
}

/** `src/a.ts` is imported four times, `src/orphan.ts` never. */
const structure: StructureIndex = {
  modules: [
    { path: 'src/a.ts', imports: [] },
    {
      path: 'src/b.ts',
      imports: [
        { from: 'src/b.ts', specifier: './a.js', resolved: 'src/a.ts' },
        { from: 'src/b.ts', specifier: 'node:path', resolved: null },
      ],
    },
    {
      path: 'src/c.ts',
      imports: [
        { from: 'src/c.ts', specifier: './a.js', resolved: 'src/a.ts' },
        { from: 'src/c.ts', specifier: './b.js', resolved: 'src/b.ts' },
        { from: 'src/c.ts', specifier: 'missing', resolved: null },
      ],
    },
    {
      path: 'src/d.ts',
      imports: [
        { from: 'src/d.ts', specifier: './a.js', resolved: 'src/a.ts' },
        { from: 'src/d.ts', specifier: './c.js', resolved: 'src/c.ts' },
        { from: 'src/d.ts', specifier: 'also-missing', resolved: null },
      ],
    },
    {
      path: 'src/orphan.ts',
      imports: [{ from: 'src/orphan.ts', specifier: './c.js', resolved: 'src/c.ts' }],
    },
  ],
  symbols: [],
  unresolved: 3,
  notes: ['the sidecar is invoked through stdio'],
}

const titles = [
  'Sentinel-TITLE-请原样复制：用一个守卫把重试预算关在一个函数里',
  '把 untrusted 回复当 JSON 形状而不是当文本处理',
  '用 realpath 决定包含关系，而不是用拼写',
  '一次解码、多次切片：按文件缓存',
  '把超时当成传输失败而不是坏回复',
  '一个渲染器只读契约，不读磁盘',
]

// --- fake client ----------------------------------------------------------

type Turn = { json: unknown } | { error: Error }

function scriptedClient(...turns: Turn[]): ModelClient & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = []
  let index = 0
  return {
    calls,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request)
      const turn = turns[Math.min(index, turns.length - 1)] as Turn
      index += 1
      if ('error' in turn) throw turn.error
      return { json: turn.json, usage: { in: 5, out: 3 } }
    },
  }
}

const deps = (client: ModelClient, over: Record<string, unknown> = {}) => ({
  client,
  profile,
  structure,
  titles,
  ...over,
})

// --- structure summary ----------------------------------------------------

describe('summarizeStructure', () => {
  it('keeps counts and the most-imported modules, not the whole index', () => {
    const summary = summarizeStructure(structure)

    expect(summary.moduleCount).toBe(5)
    expect(summary.unresolved).toBe(3)
    expect(summary.topImported[0]).toEqual({ module: 'src/a.ts', imports: 3 })
    expect(summary.topImported.map((item) => item.module)).not.toContain('src/orphan.ts')
  })

  it('is bounded and ordered by inbound imports descending', () => {
    const summary = summarizeStructure(structure, 2)

    expect(summary.topImported).toHaveLength(2)
    expect(summary.topImported.map((item) => item.module)).toEqual(['src/a.ts', 'src/c.ts'])
  })
})

// --- prompt contents ------------------------------------------------------

describe('synthesize — what the model is allowed to see', () => {
  it('sends the titles, the profile and a summary, and no code at all', async () => {
    const client = scriptedClient({ json: { problem: 'p', topFive: titles.slice(0, 5) } })

    await synthesize(
      deps(client, {
        // Extra inputs a careless caller might pass: they must not reach the
        // prompt. Evidence snippets and file bodies are the whole risk.
        points: [
          {
            title: 'x',
            theirs: { evidence: [{ path: 'src/a.ts', startLine: 1, endLine: 2, snippet: '完整实现细节' }] },
          },
        ],
        files: [{ path: 'src/a.ts', text: '完整实现细节' }],
      }),
    )

    const prompt = `${client.calls[0]?.system ?? ''}\n${client.calls[0]?.user ?? ''}`
    // The titles are the payload, verbatim.
    expect(prompt).toContain(titles[0] as string)
    // Nothing else from the analysis may reach it.
    expect(prompt).not.toContain('完整实现细节')
    expect(prompt).not.toContain('snippet')
    expect(prompt).not.toContain('evidence')
    expect(prompt).not.toContain('src/orphan.ts')
    // The summary still tells the model what shape the repository has.
    expect(prompt).toMatch(/TypeScript/)
    expect(prompt).toMatch(/package\.json/)
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('- 模块数: 5')
    expect(prompt).toContain('- 未解析导入: 3')
    expect(prompt).toContain('- 被依赖最多的模块: src/a.ts (3), src/c.ts (2), src/b.ts (1)')
  })

  it('states the output language and the verbatim rule in the system prompt', async () => {
    const client = scriptedClient({ json: { problem: 'p', topFive: titles.slice(0, 3) } })

    await synthesize(deps(client))
    const zh = client.calls[0]?.system ?? ''
    expect(zh).toContain('简体中文')
    expect(zh).toMatch(/逐字/)

    const en = scriptedClient({ json: { problem: 'p', topFive: titles.slice(0, 3) } })
    await synthesize(deps(en, { lang: 'en' }))
    const english = en.calls[0]?.system ?? ''
    expect(english).toContain('English')
    expect(english).toMatch(/verbatim/)
  })
})

// --- reply handling -------------------------------------------------------

describe('synthesize — topFive is a subset of the titles', () => {
  it('drops a title the model invented', async () => {
    const client = scriptedClient({
      json: { problem: '这个仓库把令牌预算关在一个地方。', topFive: [titles[0], '凭空编造的标题', titles[1], titles[2]] },
    })

    const result = await synthesize(deps(client))

    expect(result.problem).toBe('这个仓库把令牌预算关在一个地方。')
    expect(result.topFive).toEqual([titles[0], titles[1], titles[2]])
    expect(result.topFive.every((title) => titles.includes(title))).toBe(true)
    expect(client.calls).toHaveLength(1)
  })

  it('retries once when fewer than three titles survive, then accepts the second reply', async () => {
    const client = scriptedClient(
      { json: { problem: 'p', topFive: [titles[0], 'invented', 'invented too'] } },
      { json: { problem: 'p2', topFive: [titles[0], titles[1], titles[2], titles[3], titles[4], titles[5]] } },
    )

    const result = await synthesize(deps(client))

    expect(client.calls).toHaveLength(2)
    expect(client.calls[1]?.user).toContain(client.calls[0]?.user.split('\n')[0] as string)
    expect(result.problem).toBe('p2')
    expect(result.topFive).toEqual(titles.slice(0, 5))
  })

  it('falls back to the top-ranked titles when both replies are unusable', async () => {
    const client = scriptedClient(
      { json: { problem: 'p', topFive: ['invented'] } },
      { json: { nothing: 'useful' } },
    )

    const result = await synthesize(deps(client))

    expect(client.calls).toHaveLength(2)
    expect(result.topFive).toEqual(titles.slice(0, 5))
    expect(result.problem).not.toBe('')
  })

  it('never puts model text back into the repair prompt', async () => {
    const sentinel = 'SENTINEL-REPLY-TEXT'
    const client = scriptedClient(
      { error: new ModelReplyError(`model reply content is not JSON: {"problem":"${sentinel}"`) },
      { json: { problem: 'p2', topFive: titles.slice(0, 3) } },
    )

    const result = await synthesize(deps(client))

    expect(client.calls).toHaveLength(2)
    expect(client.calls[1]?.user).not.toContain(sentinel)
    expect(result.problem).toBe('p2')
  })

  it('returns the caller’s exact title, not the trimmed copy it matched on', async () => {
    const padded = ['  padded title  ', 'second title', 'third title']
    const client = scriptedClient({
      json: { problem: 'p', topFive: ['padded title', 'second title', 'third title'] },
    })

    const result = await synthesize(deps(client, { titles: padded }))

    expect(result.topFive).toEqual(['  padded title  ', 'second title', 'third title'])
  })

  it('returns the caller’s exact title in the fallback too', async () => {
    const padded = ['  padded title  ', 'second title', 'third title']
    const client = scriptedClient(
      { json: { nothing: 'useful' } },
      { json: { nothing: 'useful' } },
    )

    const result = await synthesize(deps(client, { titles: padded }))

    expect(result.topFive).toEqual(padded)
  })

  it('falls back on a reply that is not even JSON, without throwing', async () => {
    const client = scriptedClient(
      { error: new ModelReplyError('model reply content is not JSON') },
      { error: new ModelReplyError('model reply content is not JSON') },
    )

    const result = await synthesize(deps(client))

    expect(result.topFive).toEqual(titles.slice(0, 5))
    expect(result.problem).toMatch(/TypeScript/)
  })

  it('de-duplicates titles and never returns more than five', async () => {
    const client = scriptedClient({
      json: {
        problem: 'p',
        topFive: [titles[0], titles[0], titles[1], titles[2], titles[3], titles[4], titles[5]],
      },
    })

    const result = await synthesize(deps(client))

    expect(result.topFive).toEqual([titles[0], titles[1], titles[2], titles[3], titles[4]])
  })

  it('accepts two titles when two is all it was given', async () => {
    const client = scriptedClient({ json: { problem: 'p', topFive: ['one', 'two'] } })

    const result = await synthesize(deps(client, { titles: ['one', 'two'] }))

    expect(client.calls).toHaveLength(1)
    expect(result.topFive).toEqual(['one', 'two'])
  })

  it('does not call the model when there is nothing to rank', async () => {
    const client = scriptedClient({ json: { problem: 'p', topFive: [] } })

    const result = await synthesize(deps(client, { titles: [] }))

    expect(client.calls).toHaveLength(0)
    expect(result.topFive).toEqual([])
    expect(result.problem).not.toBe('')
  })
})

// --- failures -------------------------------------------------------------

describe('synthesize — a bad reply is never fatal', () => {
  it('propagates a transport failure after the client’s own retries', async () => {
    const client = scriptedClient({
      error: new ModelRequestError('model request failed: HTTP 500', {
        retryable: true,
        status: 500,
      }),
    })

    await expect(synthesize(deps(client))).rejects.toBeInstanceOf(ModelRequestError)
    // The client already spent its retry budget; retrying here would multiply
    // the latency instead of the odds.
    expect(client.calls).toHaveLength(1)
  })

  it('tells an empty reply apart from an unreadable one in the repair note', async () => {
    const empty = scriptedClient(
      { error: new ModelReplyError(EMPTY_CONTENT_MESSAGE) },
      { json: { problem: 'p2', topFive: titles.slice(0, 3) } },
    )

    const result = await synthesize(deps(empty))

    const note = empty.calls[1]?.user ?? ''
    expect(note).toContain('no content')
    expect(note).not.toContain('could not be read as JSON')
    expect(result.problem).toBe('p2')
  })

  it('keeps the unreadable-reply wording for a reply that is not JSON', async () => {
    const unreadable = scriptedClient(
      { error: new ModelReplyError('model reply content is not JSON: nope') },
      { json: { problem: 'p2', topFive: titles.slice(0, 3) } },
    )

    await synthesize(deps(unreadable))

    const note = unreadable.calls[1]?.user ?? ''
    expect(note).toContain('could not be read as JSON')
    expect(note).not.toContain('no content')
  })

  it('rethrows a client bug instead of spending a repair on it', async () => {
    const bug = new TypeError('cannot read properties of undefined')
    const client = scriptedClient({ error: bug })

    await expect(synthesize(deps(client))).rejects.toBe(bug)
    // A defect in our own code is not a bad reply: a retry would hide it.
    expect(client.calls).toHaveLength(1)
  })

  it('propagates a missing key instead of silently writing a fallback', async () => {
    const client = scriptedClient({ error: new MissingCredentialsError() })

    await expect(synthesize(deps(client))).rejects.toBeInstanceOf(MissingCredentialsError)
  })
})
