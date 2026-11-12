/**
 * `matchGold` is the scoring half of the evaluation harness: a produced point
 * counts only when it lands on the same file and on a line range that really
 * overlaps the hand-written gold point.
 *
 * The tests are about the edges that make a score flattering rather than true:
 * adjacency is not overlap, the same lines in another file are another claim,
 * and one gold point cannot be recovered twice by a run that reports the same
 * region twice.
 */

import { describe, expect, it } from 'vitest'

import { matchGold, readGold } from '../src/eval/match.js'
import type { GoldPoint } from '../src/eval/match.js'

const goldPoint = (path: string, startLine: number, endLine: number, why: string): GoldPoint => ({
  path,
  startLine,
  endLine,
  why,
})

describe('matchGold', () => {
  it('hits on an exact overlap', () => {
    const produced = [{ path: 'src/a.ts', startLine: 10, endLine: 12 }]
    const gold = [goldPoint('src/a.ts', 10, 12, 'the ring buffer')]

    const result = matchGold(produced, gold)

    expect(result.matched).toEqual(['the ring buffer'])
    expect(result.missed).toEqual([])
    expect(result.recall).toBe(1)
  })

  it('hits on a partial overlap in either direction', () => {
    const gold = [goldPoint('src/a.ts', 10, 20, 'the decision')]

    expect(matchGold([{ path: 'src/a.ts', startLine: 18, endLine: 30 }], gold).matched).toEqual([
      'the decision',
    ])
    expect(matchGold([{ path: 'src/a.ts', startLine: 2, endLine: 10 }], gold).matched).toEqual([
      'the decision',
    ])
    expect(matchGold([{ path: 'src/a.ts', startLine: 14, endLine: 15 }], gold).matched).toEqual([
      'the decision',
    ])
  })

  it('misses a range that only touches the gold range', () => {
    const produced = [{ path: 'src/a.ts', startLine: 13, endLine: 20 }]
    const gold = [goldPoint('src/a.ts', 10, 12, 'the ring buffer')]

    const result = matchGold(produced, gold)

    expect(result.matched).toEqual([])
    expect(result.missed).toEqual([0])
    expect(result.recall).toBe(0)
  })

  it('misses the same lines in a different file', () => {
    const produced = [{ path: 'src/b.ts', startLine: 10, endLine: 12 }]
    const gold = [goldPoint('src/a.ts', 10, 12, 'the ring buffer')]

    const result = matchGold(produced, gold)

    expect(result.matched).toEqual([])
    expect(result.missed).toEqual([0])
  })

  it('reports recall as the matched fraction, in gold order', () => {
    const produced = [
      { path: 'src/c.ts', startLine: 1, endLine: 3 },
      { path: 'src/a.ts', startLine: 9, endLine: 11 },
    ]
    const gold = [
      goldPoint('src/a.ts', 10, 12, 'first'),
      goldPoint('src/b.ts', 1, 4, 'second'),
      goldPoint('src/c.ts', 3, 5, 'third'),
    ]

    const result = matchGold(produced, gold)

    expect(result.matched).toEqual(['first', 'third'])
    expect(result.missed).toEqual([1])
    expect(result.recall).toBeCloseTo(2 / 3)
  })

  it('gives zero recall for empty gold instead of NaN', () => {
    const result = matchGold([{ path: 'src/a.ts', startLine: 1, endLine: 2 }], [])

    expect(result).toEqual({ recall: 0, matched: [], missed: [] })
  })

  it('counts a gold point once even when produced repeats the region', () => {
    const region = { path: 'src/a.ts', startLine: 10, endLine: 12 }
    const gold = [
      goldPoint('src/a.ts', 10, 12, 'the ring buffer'),
      goldPoint('src/a.ts', 30, 31, 'the cache'),
    ]

    const result = matchGold([region, { ...region }, { ...region }], gold)

    expect(result.matched).toEqual(['the ring buffer'])
    expect(result.missed).toEqual([1])
    expect(result.recall).toBe(0.5)
  })

  it('skips malformed entries instead of throwing', () => {
    const produced = [
      { path: 'src/a.ts' },
      { startLine: 10, endLine: 12 },
      { path: 'src/a.ts', startLine: '10', endLine: 12 },
      { path: 'src/a.ts', startLine: 11, endLine: 11 },
    ] as unknown as Array<{ path: string; startLine: number; endLine: number }>
    const gold = [
      goldPoint('src/a.ts', 10, 12, 'the ring buffer'),
      null as unknown as GoldPoint,
      goldPoint('src/a.ts', 40, 41, 'the cache'),
    ]

    const result = matchGold(produced, gold)

    expect(result.matched).toEqual(['the ring buffer'])
    expect(result.missed).toEqual([1, 2])
    expect(result.recall).toBeCloseTo(1 / 3)
  })
})

describe('readGold', () => {
  const good = {
    repo: 'https://example.com/repo.git',
    ref: 'main',
    sha: 'abc123',
    points: [
      { path: 'src/a.ts', startLine: 10, endLine: 12, why: 'the ring buffer' },
      { path: 'src/b.ts', startLine: 3, endLine: 3, why: 'the cache', extra: 'ignored' },
    ],
  }

  it('accepts a well-shaped gold file', () => {
    expect(readGold(good)).toEqual({
      repo: 'https://example.com/repo.git',
      ref: 'main',
      sha: 'abc123',
      points: [
        { path: 'src/a.ts', startLine: 10, endLine: 12, why: 'the ring buffer' },
        { path: 'src/b.ts', startLine: 3, endLine: 3, why: 'the cache' },
      ],
    })
  })

  it('rejects shapes that are not gold files', () => {
    expect(readGold(null)).toBeNull()
    expect(readGold('gold')).toBeNull()
    expect(readGold([])).toBeNull()
    expect(readGold({ ...good, sha: undefined })).toBeNull()
    expect(readGold({ ...good, repo: 7 })).toBeNull()
    expect(readGold({ ...good, points: 'none' })).toBeNull()
    expect(readGold({ ...good, points: [{ path: 'src/a.ts', startLine: 1, endLine: 1 }] })).toBeNull()
    expect(
      readGold({ ...good, points: [{ path: 'src/a.ts', startLine: '1', endLine: 2, why: 'x' }] }),
    ).toBeNull()
    expect(
      readGold({ ...good, points: [{ path: 'src/a.ts', startLine: 5, endLine: 2, why: 'x' }] }),
    ).toBeNull()
  })
})
