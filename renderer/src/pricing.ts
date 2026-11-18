/**
 * Money, from tokens and a price the user owns.
 *
 * The app has no business shipping a hard-coded price list: providers change
 * them, regional endpoints differ, and a number that is wrong is worse than a
 * number that is absent. So the price is a setting (USD per million tokens) and
 * these functions only do the arithmetic.
 *
 * The depth estimate is deliberately coarse. Measured on the p-queue A/B, one
 * candidate cost about 2.9k input and 3.3k output tokens, and the opening summary
 * about 0.75k / 0.95k. Those constants are an estimate, not a quote; the report's
 * usage section is the measured number.
 */

export type Price = {
  /** USD per one million input tokens. */
  input: number
  /** USD per one million output tokens. */
  output: number
}

export type DepthCost = {
  calls: number
  tokensIn: number
  tokensOut: number
  usd: number
}

const CANDIDATE_IN = 2_900
const CANDIDATE_OUT = 3_300
const SYNTHESIS_IN = 750
const SYNTHESIS_OUT = 950

/** A usable price, or null. Both sides must be real, non-negative and not both zero. */
export function priceOf(
  input: number | null | undefined,
  output: number | null | undefined,
): Price | null {
  if (typeof input !== 'number' || typeof output !== 'number') return null
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input < 0 || output < 0 || input + output === 0) return null
  return { input, output }
}

/** Cost of a measured `usage` block, in USD. */
export function costOfTokens(tokensIn: number, tokensOut: number, price: Price): number {
  return (tokensIn / 1_000_000) * price.input + (tokensOut / 1_000_000) * price.output
}

/**
 * What one depth would cost.
 *
 * `candidates + 1` calls is the judge queue plus the opening summary. The token
 * split is the measured average above; a real run can land above or below it.
 */
export function estimateDepthCost(candidates: number, price: Price): DepthCost {
  const count = Math.max(0, Math.floor(candidates))
  const tokensIn = count * CANDIDATE_IN + SYNTHESIS_IN
  const tokensOut = count * CANDIDATE_OUT + SYNTHESIS_OUT
  return {
    calls: count + 1,
    tokensIn,
    tokensOut,
    usd: costOfTokens(tokensIn, tokensOut, price),
  }
}

/** `$0.03`, `<$0.01`, or `$0.00` for a real zero. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}
