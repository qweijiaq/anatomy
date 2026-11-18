/**
 * Token arithmetic only. Prices are the user's number, not ours; these tests pin
 * the split constants and the null path that keeps a missing price from becoming
 * a made-up dollar amount.
 */

import { describe, expect, it } from 'vitest'

import { costOfTokens, estimateDepthCost, formatUsd, priceOf } from '../renderer/src/pricing.js'

describe('priceOf', () => {
  it('accepts a real pair and refuses missing, negative or all-zero prices', () => {
    expect(priceOf(0.27, 1.1)).toEqual({ input: 0.27, output: 1.1 })
    expect(priceOf(null, 1)).toBeNull()
    expect(priceOf(-1, 2)).toBeNull()
    expect(priceOf(0, 0)).toBeNull()
    expect(priceOf(Number.NaN, 1)).toBeNull()
  })
})

describe('estimateDepthCost', () => {
  it('prices a depth with the measured per-candidate split', () => {
    const cost = estimateDepthCost(6, { input: 1, output: 2 })
    expect(cost.calls).toBe(7)
    expect(cost.tokensIn).toBe(6 * 2_900 + 750)
    expect(cost.tokensOut).toBe(6 * 3_300 + 950)
    expect(cost.usd).toBeCloseTo(0.01815 + 0.0415, 6)
  })

  it('prices measured usage as it is, not as an estimate', () => {
    expect(costOfTokens(1_000_000, 0, { input: 0.5, output: 9 })).toBeCloseTo(0.5)
    expect(costOfTokens(0, 1_000_000, { input: 0.5, output: 9 })).toBeCloseTo(9)
  })
})

describe('formatUsd', () => {
  it('rounds, marks a sub-cent value, and keeps a real zero', () => {
    expect(formatUsd(0.05965)).toBe('$0.06')
    expect(formatUsd(0.001)).toBe('<$0.01')
    expect(formatUsd(0)).toBe('$0.00')
  })
})
