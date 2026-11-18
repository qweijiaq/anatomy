/**
 * Two analyses of one repository, compared by arithmetic.
 *
 * The view is only as honest as this function: a comparison that calls two different
 * repositories "before and after" is a fabricated release note, which is why the
 * warning is computed here rather than left to the renderer.
 */

import { describe, expect, it } from 'vitest'

import { diffRuns, isEmptyRunDiff, summarizeRun, type RunArtifacts } from '../src/app/run-diff.js'
import type { LearningPoint, RunManifest } from '../src/contracts/types.js'

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'r1',
    source: 'https://github.com/acme/widget',
    ref: 'main',
    sha: 'aaaaaaaa',
    subpath: '',
    engineVersion: '0.1.0',
    startedAt: '2026-11-01T10:00:00.000Z',
    status: 'complete',
    ...over,
  }
}

function point(title: string): LearningPoint {
  return { title } as unknown as LearningPoint
}

function artifacts(over: {
  manifest?: Partial<RunManifest>
  titles?: string[]
  rate?: number
  files?: number
  lines?: number
  candidates?: number
} = {}): RunArtifacts {
  return {
    manifest: manifest(over.manifest),
    points: (over.titles ?? ['a', 'b']).map(point),
    validation: {
      kept: [],
      downgraded: [],
      dropped: [],
      stats: { evidenceRate: over.rate ?? 1, droppedEvidence: 0, avgEvidence: 1 },
    },
    scope: {
      root: '',
      files: [],
      excluded: [],
      totals: { files: over.files ?? 10, bytes: 1000, lines: over.lines ?? 200 },
      byLanguage: {},
    },
    candidates: Array.from({ length: over.candidates ?? 6 }, () => ({})) as RunArtifacts['candidates'],
  }
}

describe('summarizeRun', () => {
  it('reduces artifacts to the fields a comparison can use', () => {
    const side = summarizeRun('run-1', artifacts({ titles: ['a', 'b', 'c'], rate: 0.75, candidates: 9 }))
    expect(side).toMatchObject({
      runId: 'run-1',
      source: 'https://github.com/acme/widget',
      points: 3,
      evidenceRate: 0.75,
      candidates: 9,
      files: 10,
      lines: 200,
      titles: ['a', 'b', 'c'],
    })
  })

  it('reports a missing validation artifact as a null rate, not zero', () => {
    const side = summarizeRun('run-1', { ...artifacts(), validation: null })
    expect(side.evidenceRate).toBeNull()
  })
})

describe('diffRuns', () => {
  it('finds the titles that appeared and disappeared, and counts the numbers', () => {
    const before = summarizeRun('old', artifacts({ titles: ['a', 'b'], rate: 0.5, files: 8 }))
    const after = summarizeRun('new', artifacts({ titles: ['b', 'c'], rate: 1, files: 12 }))

    const diff = diffRuns(before, after)

    expect(diff.comparable).toBe(true)
    expect(diff.sameSource).toBe(true)
    expect(diff.sameTree).toBe(true)
    expect(diff.addedTitles).toEqual(['c'])
    expect(diff.removedTitles).toEqual(['a'])
    expect(diff.counters.find((row) => row.label === '学习点')).toMatchObject({ before: 2, after: 2 })
    expect(diff.counters.find((row) => row.label === '文件')).toMatchObject({ before: 8, after: 12 })
  })

  it('refuses to present two different repositories as a before and after', () => {
    const before = summarizeRun('old', artifacts())
    const after = summarizeRun('new', artifacts({ manifest: { source: 'https://github.com/acme/other', sha: 'bbbb' } }))

    const diff = diffRuns(before, after)

    expect(diff.comparable).toBe(false)
    expect(diff.sameSource).toBe(false)
    expect(diff.warnings[0]).toContain('不是同一个仓库')
  })

  it('says when a same-named repository is a different commit', () => {
    const before = summarizeRun('old', artifacts())
    const after = summarizeRun('new', artifacts({ manifest: { sha: 'bbbb' } }))

    const diff = diffRuns(before, after)

    expect(diff.comparable).toBe(false)
    expect(diff.sameTree).toBe(false)
    expect(diff.warnings[0]).toContain('不同提交')
  })

  it('is empty only when nothing moved and the tree is the same', () => {
    const before = summarizeRun('old', artifacts())
    const after = summarizeRun('new', artifacts())

    expect(isEmptyRunDiff(diffRuns(before, after))).toBe(true)

    const moved = summarizeRun('new', artifacts({ titles: ['a', 'b', 'c'] }))
    expect(isEmptyRunDiff(diffRuns(before, moved))).toBe(false)
  })
})
