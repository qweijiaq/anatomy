/**
 * The one path in the pipeline that has no artifact to show for itself: a scan
 * that failed *and* could not record why. If this loses the cause, the reader
 * sees "could not record its outcome" and never learns what actually broke.
 */

import { describe, expect, it } from 'vitest'

import type { RunManifest } from '../src/contracts/types.js'
import { settleFailure } from '../src/kernel/pipeline.js'
import type { Run } from '../src/store/runs.js'

const manifestOf = (over: Partial<RunManifest> = {}): RunManifest => ({
  runId: 'run1',
  source: '/repo',
  ref: '',
  sha: 'abc123',
  subpath: '',
  engineVersion: '0.0.1',
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'failed',
  ...over,
})

/** A run whose every write fails, as a read-only or full disk would. */
function readOnlyRun(): Run {
  return {
    dir: '/repo/.ana/runs/run1',
    treeDir: '/repo/.ana/runs/run1/tree',
    write: () => Promise.reject(new Error('EPERM: read-only file system')),
    read: <T>(): Promise<T | null> => Promise.resolve(null),
  }
}

/** A run that accepts writes. */
function writableRun(writes: string[] = []): Run {
  return {
    dir: '/repo/.ana/runs/run1',
    treeDir: '/repo/.ana/runs/run1/tree',
    write: (name) => {
      writes.push(name)
      return Promise.resolve()
    },
    read: <T>(): Promise<T | null> => Promise.resolve(null),
  }
}

const ALL_ARTIFACTS = new Set(['scope', 'profile', 'structure', 'candidates'])

describe('settleFailure', () => {
  it('returns the stage error untouched when the manifest can be written', async () => {
    const stage = new Error('stage boom')
    const writes: string[] = []

    const thrown = await settleFailure(writableRun(writes), manifestOf(), null, new Set(), stage)

    // The stage error is what a caller must see, not a wrapper around it.
    expect(thrown).toBe(stage)
    expect(writes).toEqual(['manifest'])
  })

  it('keeps the stage error as the cause when the manifest write fails', async () => {
    const stage = new Error('stage boom')

    const thrown = await settleFailure(readOnlyRun(), manifestOf(), null, new Set(), stage)

    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error
    // Dropping the cause here is how a scan dies with no explanation at all.
    expect(error.cause).toBe(stage)
    expect(error.message).toMatch(/could not record its outcome/)
    expect(error.message).toMatch(/EPERM: read-only file system/)
    expect(error.message).toMatch(/stage boom/)
    expect(error.message).toMatch(/run1/)
  })

  it('keeps the cause on the branch that preserves an earlier complete run', async () => {
    const stage = new Error('stage boom')
    const previous = manifestOf({ status: 'complete', completedAt: '2025-12-31T00:00:00.000Z' })

    const thrown = await settleFailure(readOnlyRun(), manifestOf(), previous, new Set(), stage)

    const error = thrown as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.cause).toBe(stage)
    expect(error.message).toMatch(/stage boom/)
    expect(error.message).toMatch(/could not record its outcome/)
  })

  it('keeps the cause on the branch that marks a fully written run complete', async () => {
    const stage = new Error('stage boom')
    const writes: string[] = []

    const thrown = await settleFailure(
      readOnlyRun(),
      manifestOf(),
      null,
      ALL_ARTIFACTS,
      stage,
    )

    const error = thrown as Error
    expect(error.cause).toBe(stage)
    expect(error.message).toMatch(/stage boom/)
    expect(writes).toEqual([])
  })
})
