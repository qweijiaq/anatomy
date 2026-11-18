/**
 * The structural map is deterministic and must not invent an entry point or a
 * corridor. It is what makes a dossier usable on a product repository where the
 * learning points are all about caches rather than the product.
 */

import { describe, expect, it } from 'vitest'

import { structureGuide } from '../src/render/structure-guide.js'
import type { ReportInput } from '../src/contracts/types.js'

function input(): ReportInput {
  return {
    source: '/tmp/app',
    problem: 'an app',
    topFive: [],
    points: [],
    validation: { kept: [], downgraded: [], dropped: [], stats: { evidenceRate: 1, droppedEvidence: 0, avgEvidence: 0 } },
    profile: {
      languages: { ts: 4 },
      manifests: ['package.json'],
      entryPoints: ['electron/main.ts', 'src/index.ts', 'missing.ts', 'a', 'b', 'c', 'd'],
      hasTests: true,
      hasCi: true,
      hasDocs: true,
      notes: [],
    },
    scope: {
      root: '/tmp/app',
      files: [
        { path: 'src/a.ts', bytes: 1, lines: 1, language: 'ts' },
        { path: 'src/b.ts', bytes: 1, lines: 1, language: 'ts' },
        { path: 'src/lib/c.ts', bytes: 1, lines: 1, language: 'ts' },
        { path: 'test/a.test.ts', bytes: 1, lines: 1, language: 'ts' },
        { path: 'docs/readme.md', bytes: 1, lines: 1, language: null },
      ],
      excluded: [],
      totals: { files: 5, bytes: 5, lines: 5 },
      byLanguage: { ts: 4 },
    },
    skipped: [],
    lang: 'zh',
    structure: {
      modules: [
        { path: 'src/a.ts', imports: [{ from: 'src/a.ts', specifier: './b', resolved: 'src/b.ts' }] },
        { path: 'src/lib/c.ts', imports: [{ from: 'src/lib/c.ts', specifier: '../b', resolved: 'src/b.ts' }] },
        { path: 'src/b.ts', imports: [] },
      ],
      symbols: [],
      unresolved: 0,
      notes: [],
    },
  }
}

describe('structureGuide', () => {
  it('names the declared entry points, capped', () => {
    expect(structureGuide(input()).entries).toEqual([
      'electron/main.ts',
      'src/index.ts',
      'missing.ts',
      'a',
      'b',
      'c',
    ])
  })

  it('ranks hubs by resolved incoming imports', () => {
    expect(structureGuide(input()).hubs).toEqual([
      { path: 'src/b.ts', incoming: 2 },
    ])
  })

  it('counts source directories and ignores non-code files', () => {
    expect(structureGuide(input()).dirs).toEqual([
      { dir: 'src', files: 3 },
      { dir: 'test', files: 1 },
    ])
  })
})
