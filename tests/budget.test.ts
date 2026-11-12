import { approximateTokenSize, getModelContextSize } from 'tokenx'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BUDGET_TOKENS, type Candidate } from '../src/contracts/types.js'
import { clampBudget, estimateTokens, fitCandidates } from '../src/kernel/budget.js'

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
  it('is an upper bound on tokenx’s estimate, never a lower one', () => {
    const text = 'export function double(n: number) {\n  return n * 2\n}'
    expect(estimateTokens({ system: '', user: text })).toBeGreaterThan(
      approximateTokenSize(text),
    )
  })

  it('joins the two halves before measuring', () => {
    // 'sys' + 'tem' is one word; measured apart it would cost two.
    expect(estimateTokens({ system: 'sys', user: 'tem' })).toBe(
      estimateTokens({ system: '', user: 'system' }),
    )
  })

  it('is 0 for empty context and grows with the text', () => {
    expect(estimateTokens({ system: '', user: '' })).toBe(0)
    expect(estimateTokens({ system: '', user: 'c'.repeat(40) })).toBeLessThan(
      estimateTokens({ system: '', user: 'c'.repeat(400) }),
    )
  })

  it('charges for indentation, which tokenx rates at zero', () => {
    // 50 identical lines, one variant flush and one indented by four spaces.
    const flush = 'x = 1\n'.repeat(50)
    const indented = '    x = 1\n'.repeat(50)

    // The tokenizer cannot tell them apart, which is the bug the margin fixes.
    expect(approximateTokenSize(indented)).toBe(approximateTokenSize(flush))

    const flushCost = estimateTokens({ system: '', user: flush })
    const indentedCost = estimateTokens({ system: '', user: indented })
    expect(flushCost).toBeGreaterThan(0)
    expect(indentedCost).toBeGreaterThan(0)
    expect(indentedCost).toBeGreaterThan(flushCost)
  })

  it('does not report a whitespace-only context as free', () => {
    expect(estimateTokens({ system: '', user: ' '.repeat(4000) })).toBeGreaterThan(0)
  })
})

describe('clampBudget', () => {
  it('does not cut the budget to tokenx’s placeholder window', () => {
    // `getModelContextSize('gpt-4o')` answers 8192 and an unknown name answers
    // 4097, so clamping on it turned a 100k batch into a four-candidate batch.
    // The batch limit is the caller's number; the real window is unknown here.
    expect(clampBudget(DEFAULT_BUDGET_TOKENS, 'gpt-4o')).toBe(DEFAULT_BUDGET_TOKENS)
    expect(clampBudget(500_000, 'gpt-3.5-turbo')).toBe(500_000)
  })

  it('keeps a limit that already fits', () => {
    expect(clampBudget(500, 'gpt-4')).toBe(500)
  })

  it('leaves an unknown model’s budget to the caller', () => {
    // Tokenx answers 4097 for every name it does not know. Trusting that would
    // make a run on a local or self-hosted model analyse almost nothing.
    expect(clampBudget(1_000_000, 'some-future-model')).toBe(1_000_000)
    expect(clampBudget(1_000_000)).toBe(1_000_000)
  })

  it('throws on a limit that is not finite, like the budget it guards', () => {
    for (const limit of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => clampBudget(limit, 'gpt-4')).toThrow(/finite/)
    }
  })
})

describe('DEFAULT_BUDGET_TOKENS', () => {
  it('fits inside every context size tokenx knows, with headroom', () => {
    expect(DEFAULT_BUDGET_TOKENS).toBe(100_000)
    // 128k, the largest window in tokenx's table, still leaves 28k of headroom
    // for the answer and the fixed prompt around the batch.
    expect(DEFAULT_BUDGET_TOKENS).toBeLessThan(128_000)
  })

  it('survives every named model without shrinking', () => {
    for (const model of ['gpt-4', 'gpt-3.5-turbo', 'gpt-4-32k', 'gpt-4o', 'text-davinci-003']) {
      expect(clampBudget(DEFAULT_BUDGET_TOKENS, model)).toBe(DEFAULT_BUDGET_TOKENS)
    }
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
    // A budget that is zero or negative keeps nothing: the guard never widens
    // into "unlimited" by accident.
    for (const limit of [0, -10]) {
      const fit = fitCandidates([small, mid, big], ctxOf, limit)
      expect(fit.kept).toEqual([])
      expect(fit.dropped).toBe(3)
    }
  })

  it('throws instead of silently dropping everything on a non-finite limit', () => {
    // `Infinity` was coerced to 0 and cost the whole batch without a word.
    for (const limit of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() => fitCandidates([small, mid, big], ctxOf, limit)).toThrow(/finite/)
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
