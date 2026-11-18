/**
 * Counts what a run actually spends.
 *
 * The client returns the provider's `usage` on every reply, and every caller used
 * to add it to a local number that never left the function. A run could therefore
 * cost more than its ceiling without anything noticing, and the report had no way
 * to say what it cost at all.
 *
 * The meter wraps the client once, at the head of the run. Every call — judge,
 * synthesis, a repair attempt — goes through it, so the totals include the
 * retries that a hand-written sum always forgets.
 */

import type { ModelClient, ModelResponse, Usage } from './client.js'

export type UsageSnapshot = { calls: number; usage: Usage }

export type UsageMeter = {
  /** Pass this to every stage; do not pass the unwrapped client. */
  client: ModelClient
  /** A copy, so a later call cannot change a number already recorded. */
  snapshot(): UsageSnapshot
}

export function metered(client: ModelClient): UsageMeter {
  const usage: Usage = { in: 0, out: 0 }
  let calls = 0
  return {
    client: {
      async complete(request): Promise<ModelResponse> {
        const reply = await client.complete(request)
        calls += 1
        usage.in += reply.usage.in
        usage.out += reply.usage.out
        return reply
      },
    },
    snapshot(): UsageSnapshot {
      return { calls, usage: { in: usage.in, out: usage.out } }
    },
  }
}

/** The difference between two snapshots, for a stage boundary. */
export function between(
  before: UsageSnapshot,
  after: UsageSnapshot,
): { calls: number; in: number; out: number } {
  return {
    calls: after.calls - before.calls,
    in: after.usage.in - before.usage.in,
    out: after.usage.out - before.usage.out,
  }
}
