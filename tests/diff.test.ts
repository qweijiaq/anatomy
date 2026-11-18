/**
 * `ana diff` is the same comparison the window shows, with a JSON exit.
 *
 * The command reads two run directories and never re-analyses; these tests make
 * sure it reads the artifacts it claims to and that a missing or incomplete run is
 * an error rather than a comparison against zeroes.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { DiffUsageError, formatDiff, parseDiffArgs, runDiff } from '../src/commands/diff.js'
import type { LearningPoint } from '../src/contracts/types.js'

function storeRun(
  baseDir: string,
  runId: string,
  options: { titles: string[]; rate: number; sha?: string; source?: string },
): void {
  const dir = path.join(baseDir, runId)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    runId,
    source: options.source ?? '/tmp/repo',
    ref: '',
    sha: options.sha ?? 'aaaaaaa',
    subpath: '',
    engineVersion: '0.1.0',
    startedAt: '2026-11-01T00:00:00.000Z',
    status: 'complete',
    completedAt: '2026-11-01T00:01:00.000Z',
    lang: 'zh',
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(
    path.join(dir, 'points.json'),
    JSON.stringify(
      options.titles.map(
        (title) =>
          ({
            id: title,
            title,
            kind: 'architecture',
            problem: { constraint: '', stakes: '' },
            alternatives: [],
            theirs: { summary: '', evidence: [] },
            mechanism: '',
            tradeoffs: [],
            confidence: 'high',
            unknowns: [],
            recipe: null,
          }) satisfies LearningPoint,
      ),
    ),
  )
  writeFileSync(
    path.join(dir, 'validation.json'),
    JSON.stringify({
      kept: [],
      downgraded: [],
      dropped: [],
      stats: { evidenceRate: options.rate, droppedEvidence: 0, avgEvidence: 1 },
    }),
  )
  writeFileSync(
    path.join(dir, 'scope.json'),
    JSON.stringify({
      root: '/tmp/repo',
      files: [],
      excluded: [],
      totals: { files: 5, bytes: 10, lines: 20 },
      byLanguage: {},
    }),
  )
  writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify([]))
}

describe('ana diff', () => {
  it('compares two stored runs and prints the number changes and titles', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-diff-'))
    storeRun(baseDir, 'old', { titles: ['a', 'b'], rate: 0.5 })
    storeRun(baseDir, 'new', { titles: ['b', 'c'], rate: 1 })

    const diff = await runDiff('old', 'new', { baseDir })
    expect(diff.comparable).toBe(true)
    expect(diff.addedTitles).toEqual(['c'])
    expect(diff.removedTitles).toEqual(['a'])

    const text = formatDiff(diff)
    expect(text).toContain('before')
    expect(text).toContain('+ c')
    expect(text).toContain('- a')
    expect(text).toContain('50.0% -> 100.0%')
  })

  it('labels a comparison of two repositories instead of calling it a version change', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-diff-cross-'))
    storeRun(baseDir, 'a', { titles: ['a'], rate: 1, source: '/tmp/one' })
    storeRun(baseDir, 'b', { titles: ['b'], rate: 1, source: '/tmp/two' })
    const diff = await runDiff('a', 'b', { baseDir })
    expect(diff.sameSource).toBe(false)
    expect(diff.warnings[0]).toContain('不是同一个仓库')
    expect(diff.addedTitles).toEqual(['b'])
  })

  it('says when a run is missing instead of comparing against nothing', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-diff-missing-'))
    storeRun(baseDir, 'old', { titles: ['a'], rate: 1 })
    await expect(runDiff('old', 'missing', { baseDir })).rejects.toBeInstanceOf(DiffUsageError)
  })
})

describe('diff grammar', () => {
  it('takes two ids, --json and --dir', () => {
    const args = parseDiffArgs(['a', 'b', '--json', '--dir', '/tmp/runs'])
    expect(args).toMatchObject({ help: false, before: 'a', after: 'b', json: true })
    expect(args.help === false && args.options.baseDir).toContain('/tmp/runs')
  })

  it('rejects one id and unknown flags', () => {
    expect(() => parseDiffArgs(['a'])).toThrow(DiffUsageError)
    expect(() => parseDiffArgs(['a', 'b', '--bogus'])).toThrow(DiffUsageError)
  })
})
