/**
 * A follow-up is only worth having if it cannot invent evidence.
 *
 * These tests drive the validator, not the prose: a citation that is not one of
 * the run's stored ranges must be refused, an unanswered question must not sneak a
 * citation in, and a repair is a second chance to obey the rule rather than a
 * relaxation of it.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseAskArgs, AskUsageError, formatAsk, runAsk } from '../src/commands/ask.js'
import { answerQuestion, AnswerRejectedError } from '../src/writing/answer.js'
import type { LearningPoint, ReportInput } from '../src/contracts/types.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/writing/client.js'

function point(title: string, path: string, start: number, end: number, snippet: string): LearningPoint {
  return {
    id: title,
    title,
    kind: 'architecture',
    problem: { constraint: 'a constraint', stakes: 'some stakes' },
    alternatives: [],
    theirs: {
      summary: 'what they did',
      evidence: [{ id: `${title}-e`, path, startLine: start, endLine: end, snippet }],
    },
    mechanism: 'how it works',
    tradeoffs: [],
    confidence: 'high',
    unknowns: [],
    recipe: null,
  }
}

function input(points: LearningPoint[]): ReportInput {
  return {
    source: '/tmp/repo',
    problem: 'a repository',
    topFive: points.map((point) => point.title),
    points,
    validation: {
      kept: points,
      downgraded: [],
      dropped: [],
      stats: { evidenceRate: 1, droppedEvidence: 0, avgEvidence: 1 },
    },
    profile: {
      languages: { ts: 1 },
      manifests: [],
      entryPoints: [],
      hasTests: false,
      hasCi: false,
      hasDocs: false,
      notes: [],
    },
    scope: {
      root: '/tmp/repo',
      files: [],
      excluded: [],
      totals: { files: 1, bytes: 1, lines: 1 },
      byLanguage: {},
    },
    skipped: [],
    lang: 'zh',
  }
}

function client(replies: Array<Record<string, unknown>>): ModelClient & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = []
  let index = 0
  return {
    seen,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      seen.push(request)
      const json = replies[Math.min(index, replies.length - 1)]
      index += 1
      return { json, usage: { in: 10, out: 5 } }
    },
  }
}

const report = input([point('环形缓冲', 'src/ring.ts', 1, 8, 'export class Ring {}')])

describe('answerQuestion', () => {
  it('accepts an answer whose citations are stored ranges', async () => {
    const fake = client([
      { answered: true, answer: '它用固定容量避免搬移 `src/ring.ts:1-8`。', citations: ['src/ring.ts:1-8'] },
    ])
    const answer = await answerQuestion({ client: fake, input: report, question: '为什么不用链表？' })
    expect(answer.answered).toBe(true)
    expect(answer.citations).toEqual(['src/ring.ts:1-8'])
    expect(answer.usage).toEqual({ in: 10, out: 5 })
    // The prompt contains the evidence and the question, and nothing about a tree.
    expect(fake.seen[0]?.user).toContain('src/ring.ts:1-8')
    expect(fake.seen[0]?.user).toContain('为什么不用链表？')
  })

  it('refuses a citation the run never stored', async () => {
    const fake = client([
      { answered: true, answer: '因为 `src/other.ts:1-2`。', citations: ['src/other.ts:1-2'] },
    ])
    await expect(
      answerQuestion({ client: fake, input: report, question: '为什么？' }),
    ).rejects.toBeInstanceOf(AnswerRejectedError)
    expect(fake.seen).toHaveLength(2)
  })

  it('accepts a repaired answer, and still validates it', async () => {
    const fake = client([
      { answered: true, answer: '因为 `src/other.ts:1-2`。', citations: ['src/other.ts:1-2'] },
      { answered: true, answer: '因为 `src/ring.ts:1-8`。', citations: ['src/ring.ts:1-8'] },
    ])
    const answer = await answerQuestion({ client: fake, input: report, question: '为什么？' })
    expect(answer.citations).toEqual(['src/ring.ts:1-8'])
    expect(fake.seen).toHaveLength(2)
    expect(fake.seen[1]?.user).toContain('上一次回答被拒绝')
  })

  it('allows "the evidence does not answer" without a citation', async () => {
    const fake = client([
      { answered: false, answer: '报告没有关于部署方式的内容。', citations: [] },
    ])
    const answer = await answerQuestion({ client: fake, input: report, question: '怎么部署？' })
    expect(answer.answered).toBe(false)
    expect(answer.answer).toContain('部署')
    expect(answer.citations).toEqual([])
  })

  it('rejects a claim that cites nothing', async () => {
    const fake = client([{ answered: true, answer: '它更快。', citations: [] }])
    await expect(
      answerQuestion({ client: fake, input: report, question: '为什么？' }),
    ).rejects.toBeInstanceOf(AnswerRejectedError)
  })

  it('formats an answer with its citations for the terminal', async () => {
    const fake = client([
      { answered: true, answer: '答案 `src/ring.ts:1-8`。', citations: ['src/ring.ts:1-8'] },
    ])
    const answer = await answerQuestion({ client: fake, input: report, question: '为什么？' })
    const text = formatAsk(answer)
    expect(text).toContain('答案')
    expect(text).toContain('- src/ring.ts:1-8')
  })
})

describe('ask grammar', () => {
  it('takes the run id and the rest of the words as the question', () => {
    const args = parseAskArgs(['run-1', 'why', 'not', 'a', 'list', '--json'])
    expect(args).toMatchObject({ help: false, runId: 'run-1', question: 'why not a list', json: true })
  })

  it('rejects a question-less invocation and an unknown flag', () => {
    expect(() => parseAskArgs(['run-1'])).toThrow(AskUsageError)
    expect(() => parseAskArgs(['run-1', 'why', '--bogus'])).toThrow(AskUsageError)
    expect(() => parseAskArgs(['run-1', 'why', '--lang', 'fr'])).toThrow(AskUsageError)
  })
})


describe('runAsk against a stored run', () => {
  it('reads the report directory and answers with a stored citation', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-ask-'))
    const runId = 'run-1'
    const dir = path.join(baseDir, runId)
    mkdirSync(dir, { recursive: true })
    const stored = report
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        runId,
        source: '/tmp/repo',
        ref: '',
        sha: 'abc',
        subpath: '',
        engineVersion: '0.1.0',
        startedAt: '2026-11-01T00:00:00.000Z',
        status: 'complete',
        completedAt: '2026-11-01T00:00:01.000Z',
        lang: 'zh',
      }),
    )
    writeFileSync(path.join(dir, 'points.json'), JSON.stringify(stored.points))
    writeFileSync(path.join(dir, 'validation.json'), JSON.stringify(stored.validation))
    writeFileSync(
      path.join(dir, 'synthesis.json'),
      JSON.stringify({ problem: stored.problem, topFive: stored.topFive }),
    )
    writeFileSync(path.join(dir, 'skipped.json'), '[]')
    writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(stored.profile))
    writeFileSync(path.join(dir, 'scope.json'), JSON.stringify(stored.scope))

    const fake = client([
      { answered: true, answer: '固定容量避免搬移 `src/ring.ts:1-8`。', citations: ['src/ring.ts:1-8'] },
    ])
    const answer = await runAsk(runId, '为什么不用链表？', { baseDir, client: fake })
    expect(answer.answered).toBe(true)
    expect(answer.citations).toEqual(['src/ring.ts:1-8'])
    expect(formatAsk(answer)).toContain('- src/ring.ts:1-8')
  })
})
