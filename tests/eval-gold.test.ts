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
    // Pinning is the whole contract: a floating ref rescores the same claims
    // against different code, and a placeholder sha (`0000...`) does not even
    // resolve, so the eval fails instead of measuring.
    expect(gold.ref.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(gold.sha.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(gold.points.length).toBeGreaterThanOrEqual(3)

    for (const point of gold.points) {
      expect(point.why.trim(), `${file} ${point.path} has no why`).not.toBe('')
      expect(point.startLine).toBeGreaterThanOrEqual(1)
      expect(point.startLine).toBeLessThanOrEqual(point.endLine)
    }
  })

  // A range nobody measured is a guess, and a guess that scores a pipeline is
  // worse than no score. Every file therefore states which it is: `provisional`
  // is a required boolean, and a provisional file must say so where a reader
  // sees it first.
  it.each(goldFiles)('%s states whether its line numbers were measured', (file) => {
    const raw = rawOf(file)

    expect(typeof raw['provisional'], `${file} has no provisional flag`).toBe('boolean')
    const note = String(raw['note'] ?? '')
    expect(note, `${file} has no note`).not.toBe('')
    if (raw['provisional'] === true) expect(note).toContain('PROVISIONAL')
  })
})
