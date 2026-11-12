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
 * Cuts are reported, never silent: a caller that is told `dropped: 12` can say
 * so in the output, which is the difference between analysis and a guess.
 */

import { approximateTokenSize } from 'tokenx'

import type { Candidate } from '../contracts/types.js'

/** Estimated tokens of one prompting context. Empty context is 0, not 1. */
export function estimateTokens(ctx: { system: string; user: string }): number {
  return approximateTokenSize(`${ctx.system}${ctx.user}`)
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
 * A `limit` that is not a finite number keeps nothing: a broken budget is not
 * an unlimited budget.
 */
export function fitCandidates(
  cands: Candidate[],
  ctxOf: (c: Candidate) => { system: string; user: string },
  limit: number,
): { kept: Candidate[]; dropped: number } {
  const ordered = cands
    .map((candidate, index): Slot => ({ candidate, index }))
    .sort(compare)

  let remaining = Number.isFinite(limit) && limit > 0 ? limit : 0
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
