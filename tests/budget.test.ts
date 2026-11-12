import { approximateTokenSize } from 'tokenx'
import { describe, expect, it } from 'vitest'

import type { Candidate } from '../src/contracts/types.js'
import { estimateTokens, fitCandidates } from '../src/kernel/budget.js'

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'c',
  path: 'src/a.ts',
  line: 1,
  kind: 'complexity',
  score: 5,
  matched: ['nested'],
  ...over,
})

/** Text is the only thing that costs tokens, so the id chooses the cost. */
const textOf = (id: string): string =>
  id === 'big' ? 'a'.repeat(4000) : id === 'mid' ? 'b'.repeat(400) : 'c'.repeat(40)

const ctxOf = (c: Candidate) => ({ system: '', user: textOf(c.id) })

const costOf = (c: Candidate) => estimateTokens(ctxOf(c))

describe('estimateTokens', () => {
  it('is tokenx’s estimate of the concatenation', () => {
    expect(estimateTokens({ system: '', user: 'hello world' })).toBe(
      approximateTokenSize('hello world'),
    )
    // The two halves are joined, not measured separately.
    expect(estimateTokens({ system: 'sys', user: 'tem' })).toBe(
      approximateTokenSize('system'),
    )
  })

  it('is 0 for empty context and grows with the text', () => {
    expect(estimateTokens({ system: '', user: '' })).toBe(0)
    expect(estimateTokens({ system: '', user: 'c'.repeat(40) })).toBeLessThan(
      estimateTokens({ system: '', user: 'c'.repeat(400) }),
    )
  })
})

describe('fitCandidates', () => {
  const big = candidate({ id: 'big', path: 'src/a.ts', line: 1, score: 9 })
  const mid = candidate({ id: 'mid', path: 'src/b.ts', line: 1, score: 7 })
  const small = candidate({ id: 'small', path: 'src/c.ts', line: 1, score: 5 })

  it('keeps everything, in score order, when the budget is ample', () => {
    const fit = fitCandidates([small, big, mid], ctxOf, 1_000_000)

    expect(fit.kept.map((c) => c.id)).toEqual(['big', 'mid', 'small'])
    expect(fit.dropped).toBe(0)
  })

  it('spends the budget greedily by score and reports how many it cut', () => {
    const limit = costOf(mid) + costOf(small)

    const fit = fitCandidates([small, big, mid], ctxOf, limit)

    // `big` outscores everything but cannot fit, so budget skips it and keeps
    // spending on what does.
    expect(fit.kept.map((c) => c.id)).toEqual(['mid', 'small'])
    expect(fit.dropped).toBe(1)
  })

  it('keeps scanning after a candidate is skipped', () => {
    const fit = fitCandidates([big, mid, small], ctxOf, costOf(mid) - 1)

    expect(fit.kept.map((c) => c.id)).toEqual(['small'])
    expect(fit.dropped).toBe(2)
  })

  it('drops everything when no budget is left', () => {
    // A budget that is zero, negative or not a number keeps nothing: the guard
    // never widens into "unlimited" by accident.
    for (const limit of [0, -10, Number.NaN]) {
      const fit = fitCandidates([small, mid, big], ctxOf, limit)
      expect(fit.kept).toEqual([])
      expect(fit.dropped).toBe(3)
    }
  })

  it('breaks score ties by path, then line, so the order does not depend on input', () => {
    const tied = [
      candidate({ id: 'z', path: 'src/b.ts', line: 2 }),
      candidate({ id: 'a9', path: 'src/a.ts', line: 9 }),
      candidate({ id: 'a1', path: 'src/a.ts', line: 1 }),
    ]

    expect(fitCandidates(tied, ctxOf, 1_000_000).kept.map((c) => c.id)).toEqual([
      'a1',
      'a9',
      'z',
    ])
    expect(fitCandidates([...tied].reverse(), ctxOf, 1_000_000).kept.map((c) => c.id)).toEqual([
      'a1',
      'a9',
      'z',
    ])
  })

  it('does not throw on a candidate whose score is not a number', () => {
    const fit = fitCandidates(
      [candidate({ id: 'mid', score: 5 }), candidate({ id: 'small', score: Number.NaN })],
      ctxOf,
      1_000_000,
    )

    // An unreadable score is sorted last rather than crashing the budget.
    expect(fit.kept.map((c) => c.id)).toEqual(['mid', 'small'])
  })

  it('returns an empty result for an empty candidate list', () => {
    expect(fitCandidates([], ctxOf, 10)).toEqual({ kept: [], dropped: 0 })
  })
})
