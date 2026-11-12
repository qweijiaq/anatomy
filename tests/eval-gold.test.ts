/**
 * The gold set is the only hand-written input the eval has, and it is read at
 * scoring time by a total, all-or-nothing parser. So this test is the set's own
 * contract: every file parses, names a repository and a commit, and carries at
 * least three claims that are checkable against a checkout.
 *
 * No network: these are the files on disk, and the point is that a broken fixture
 * fails here rather than silently lowering a score someone quotes later.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { readGold } from '../src/eval/match.js'

const GOLD_DIR = fileURLToPath(new URL('../eval/gold/', import.meta.url))

const goldFiles = readdirSync(GOLD_DIR)
  .filter((entry) => entry.endsWith('.json'))
  .sort()

function rawOf(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(GOLD_DIR, file), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

describe('eval/gold', () => {
  it('holds at least the three seed repositories', () => {
    expect(goldFiles.length).toBeGreaterThanOrEqual(3)
  })

  it.each(goldFiles)('%s is a gold file', (file) => {
    const gold = readGold(rawOf(file))

    expect(gold, `${file} is not a gold file`).not.toBeNull()
    if (gold === null) return

    expect(gold.repo.trim()).not.toBe('')
    expect(gold.ref.trim()).not.toBe('')
    expect(gold.sha.trim()).not.toBe('')
    expect(gold.points.length).toBeGreaterThanOrEqual(3)

    for (const point of gold.points) {
      expect(point.why.trim(), `${file} ${point.path} has no why`).not.toBe('')
      expect(point.startLine).toBeGreaterThanOrEqual(1)
      expect(point.startLine).toBeLessThanOrEqual(point.endLine)
    }
  })

  // A range nobody pinned is a guess, and a guess that scores a pipeline is worse
  // than no score. The file has to say so, in a place a reader sees first.
  it.each(goldFiles)('%s says its line numbers are provisional', (file) => {
    const raw = rawOf(file)

    expect(raw['provisional']).toBe(true)
    expect(String(raw['note'] ?? '')).toContain('PROVISIONAL')
  })
})
