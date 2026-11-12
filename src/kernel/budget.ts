/**
 * Token budgeting: how much of the model's context a batch of candidates is
 * allowed to spend.
 *
 * The estimate is deliberately not a tokenizer. The budget decides *how many*
 * candidates to hand on and how many to report as cut; being a few percent off
 * costs nothing, while shipping a real tokenizer costs startup time on every
 * run. `tokenx`'s estimator (the `estimateTokenCount` of the task spec) is
 * installed as `approximateTokenSize` in 0.4.x and is what this module uses.
 *
 * It is, however, a lower bound, not an upper one: `tokenx` scores whitespace
 * as nothing at all (4000 spaces cost 0 tokens, and indented code costs exactly
 * what flush code costs, ~33% under on ordinary source). A batch reported as
 * fitting could then not fit. So the estimate is corrected upward before it is
 * spent; see `estimateTokens` for the rule.
 *
 * Cuts are reported, never silent: a caller that is told `dropped: 12` can say
 * so in the output, which is the difference between analysis and a guess.
 */

import { approximateTokenSize } from 'tokenx'


import type { Candidate } from '../contracts/types.js'

/**
 * A BPE tokenizer gives a run of spaces about one token per four characters, and
 * `tokenx` gives it zero, so every whitespace character is charged at that rate.
 */
const CHARS_PER_TOKEN = 4

/**
 * `tokenx` undercounts ordinary source by roughly a third; the margin makes the
 * estimate an upper bound rather than a lower one.
 */
const SAFETY_MARGIN = 1.3

/** One budget limit, refused unless it is a real number. */
function finiteLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    throw new Error(`anatomy: budget limit must be a finite number, got ${String(limit)}`)
  }
  return limit
}

/**
 * Estimated tokens of one prompting context. Empty context is 0, not 1.
 *
 * The documented rule, in order:
 *
 * 1. `tokenx`'s estimate of `system + user` joined (joining first, because a
 *    word split across the two halves is one token, not two).
 * 2. Plus one token per four whitespace characters. `tokenx` scores whitespace
 *    as free, so without this every space is lost: a blank line, an indentation
 *    run or a padded table all cost nothing, and 4000 spaces cost 0.
 * 3. Times 1.3, because `tokenx` undercounts ordinary source by about a third.
 * 4. Rounded up, so a nonzero context never estimates as free.
 */
export function estimateTokens(ctx: { system: string; user: string }): number {
  const text = `${ctx.system}${ctx.user}`
  if (text === '') return 0

  const measured = approximateTokenSize(text)
  const whitespace = text.length - text.replace(/\s/g, '').length
  const corrected = measured + whitespace / CHARS_PER_TOKEN
  return Math.ceil(corrected * SAFETY_MARGIN)
}

/**
 * The most this batch may spend.
 *
 * It deliberately does **not** consult `getModelContextSize`: tokenx's table
 * answers 4097 for every model it does not know and 8192 for `gpt-4o`, so using
 * it as a ceiling cut a 100k budget to 4k and silently discarded almost every
 * candidate. A batch limit is the caller's number; the provider's real window is
 * unknown here and guessing it is worse than trusting the caller.
 */
export function clampBudget(limit: number, _model?: string): number {
  return finiteLimit(limit)
}

/** A candidate paired with its position, so ties stay in input order. */
type Slot = { candidate: Candidate; index: number }

function scoreOf(candidate: Candidate): number {
  return Number.isFinite(candidate.score) ? candidate.score : Number.NEGATIVE_INFINITY
}

/**
 * Score descending, then `path` and `line` ascending, then input order.
 *
 * The tie-breakers are what make the cut reproducible: two runs over the same
 * tree must keep the same candidates, whatever order the signal walk produced.
 */
function compare(left: Slot, right: Slot): number {
  const scores = scoreOf(left.candidate) - scoreOf(right.candidate)
  if (scores !== 0 && !Number.isNaN(scores)) return scores > 0 ? -1 : 1

  const leftPath = left.candidate.path
  const rightPath = right.candidate.path
  if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1

  const leftLine = Number.isFinite(left.candidate.line) ? left.candidate.line : 0
  const rightLine = Number.isFinite(right.candidate.line) ? right.candidate.line : 0
  if (leftLine !== rightLine) return leftLine - rightLine

  return left.index - right.index
}

/**
 * Keeps as many candidates as `limit` tokens allow, best score first.
 *
 * Greedy, and it keeps going past a candidate that does not fit: a single huge
 * candidate must not end the budget for everything smaller behind it. Whatever
 * was cut is summed into `dropped` so the loss can be stated.
 *
 * A `limit` that is not a finite number is a caller bug, not a budget: it threw
 * rather than being coerced to 0, which silently dropped the whole batch. A
 * finite `limit` of zero or less keeps nothing, so a spent budget never widens
 * into an unlimited one by accident.
 */
export function fitCandidates(
  cands: Candidate[],
  ctxOf: (c: Candidate) => { system: string; user: string },
  limit: number,
): { kept: Candidate[]; dropped: number } {
  const ordered = cands
    .map((candidate, index): Slot => ({ candidate, index }))
    .sort(compare)

  const bounded = finiteLimit(limit)
  let remaining = bounded > 0 ? bounded : 0
  const kept: Candidate[] = []
  let dropped = 0

  for (const { candidate } of ordered) {
    const cost = estimateTokens(ctxOf(candidate))
    if (cost <= remaining) {
      kept.push(candidate)
      remaining -= cost
    } else {
      dropped += 1
    }
  }

  return { kept, dropped }
}
