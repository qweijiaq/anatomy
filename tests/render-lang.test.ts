/**
 * The English page.
 *
 * `--lang en` used to switch the model's prose and nothing else, so the report was
 * an English body under Chinese headings — a feature the README described as half
 * finished rather than claiming something untrue. These tests pin the other half:
 * every word this code writes follows the language too, and no Chinese survives.
 */

import { describe, expect, it } from 'vitest'

import type { Candidate, LearningPoint, ReportInput } from '../src/contracts/types.js'
import { labelsFor } from '../src/render/labels.js'
import { renderMarkdown } from '../src/render/markdown.js'

const HAN = /[\u4e00-\u9fff]/

function pointOf(over: Partial<LearningPoint> = {}): LearningPoint {
  return {
    id: 'p1',
    title: 'Fold the guard into one loop condition',
    kind: 'algorithm',
    problem: { constraint: 'two exits, one invariant', stakes: 'a missed exit loops forever' },
    alternatives: [{ approach: 'two separate checks', cost: 'the second one is forgotten' }],
    theirs: {
      summary: 'one compound guard',
      evidence: [
        {
          id: 'ev1',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          snippet: 'while (a && b) run()',
        },
      ],
    },
    mechanism: 'there is no second place to forget',
    tradeoffs: [{ cost: 'harder to debug', whenItHurts: 'when the loop never runs' }],
    confidence: 'high',
    unknowns: ['what the caller expects'],
    recipe: {
      prereqs: ['two conditions'],
      minimalForm: 'while (a && b) {}',
      avoidWhen: ['the conditions are unrelated'],
    },
    ...over,
  }
}

function reportOf(over: Partial<ReportInput> = {}): ReportInput {
  return {
    source: 'https://example.test/repo',
    problem: 'A small library with one sharp idea.',
    topFive: ['Fold the guard into one loop condition'],
    points: [pointOf()],
    validation: { kept: [], downgraded: [], dropped: [], stats: {} } as never,
    profile: {
      languages: { ts: 1 },
      manifests: ['package.json'],
      entryPoints: ['src/a.ts'],
      hasTests: true,
      hasCi: false,
      hasDocs: true,
      notes: [],
    },
    scope: {
      root: '/tmp/repo',
      // Two files: the size table is suppressed for a one-file repository, where it
      // would say nothing a reader did not already know.
      files: [
        { path: 'src/a.ts', bytes: 100, lines: 10, language: 'ts' },
        { path: 'src/b.ts', bytes: 50, lines: 5, language: 'ts' },
      ],
      excluded: [],
      totals: { files: 2, bytes: 150, lines: 15 },
      byLanguage: { ts: 1 },
    },
    skipped: [],
    candidates: [
      {
        id: 'c1',
        path: 'src/a.ts',
        line: 1,
        kind: 'complexity',
        score: 2,
        matched: ['complexity:guard-ladder'],
      } satisfies Candidate,
    ],
    structure: {
      modules: [{ path: 'src/a.ts', imports: [] }],
      symbols: [{ name: 'run', kind: 'function', path: 'src/a.ts', line: 1 }],
      unresolved: 0,
      notes: [],
    },
    lang: 'en',
    ...over,
  }
}

describe('labelsFor', () => {
  it('has an entry for every field in both languages', () => {
    const zh = Object.keys(labelsFor('zh')).sort()
    const en = Object.keys(labelsFor('en')).sort()
    // A field present in one and not the other would be a runtime `undefined` in a
    // heading; making the type total is the guarantee, this is the check that the
    // two objects were actually written out in full.
    expect(en).toEqual(zh)
  })
})

describe('renderMarkdown in English', () => {
  it('leaves no Chinese anywhere in the page this code writes', () => {
    const md = renderMarkdown(reportOf())
    const offenders = md
      .split('\n')
      .filter((line) => HAN.test(line))
      // The fixture's own prose is English, so any Han character is one of ours.
      .slice(0, 5)
    expect(offenders).toEqual([])
  })

  it('translates the headings, labels and units, not just the prose', () => {
    const md = renderMarkdown(reportOf())
    expect(md).toContain('## What this analysis is about')
    expect(md).toContain('## How much of this is verifiable')
    expect(md).toContain('## What was analysed')
    expect(md).toContain('## What was not looked at')
    expect(md).toContain('2 files / 150 bytes / 15 lines')
  })

  it('translates the appendix, including the sentence that denies the score', () => {
    const md = renderMarkdown(reportOf())
    expect(md).toContain('## Places worth looking at yourself')
    expect(md).toContain('## The shape of the repository')
    expect(md).toContain('## Where the code sits')
    expect(md).toContain('is not a quality')
    // The declaration column comes from `structure.symbols`.
    expect(md).toContain('`run` (function)')
  })

  it('keeps the snippet verbatim — code is never translated', () => {
    const md = renderMarkdown(reportOf())
    expect(md).toContain('while (a && b) run()')
  })

  it('still renders Chinese when the run asked for Chinese', () => {
    const md = renderMarkdown(reportOf({ lang: 'zh', problem: '一个很薄的想法。' }))
    expect(md).toContain('## 这次分析在解决什么')
    expect(md).toContain('## 没看的部分')
  })

  it('defaults to Chinese for a run recorded before the language was stored', () => {
    const md = renderMarkdown(reportOf({ lang: undefined }))
    expect(md).toContain('## 这次分析在解决什么')
  })
})

describe('the language travels with the run', () => {
  /**
   * One run, two renderings.
   *
   * The page written at the end of `analyze` and the page written later by
   * `analyze report` are the same data through the same renderer, so they must
   * agree. They did not: `analyze` built its `ReportInput` without `lang`, so the
   * fresh `report.md` was Chinese while re-rendering the same run was English — the
   * re-render reads `manifest.lang` and the write did not.
   */
  it('renders the same language before and after a re-render', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/commands/analyze.ts', import.meta.url), 'utf8'),
    )
    const block = /const report: ReportInput = \{([\s\S]*?)\n\s*\}/.exec(source)
    expect(block, 'ReportInput construction not found').not.toBeNull()
    // The field has to be set where the page is first written, not only where it is
    // re-read.
    expect(block?.[1]).toContain('lang')
  })
})

describe('the empty report says why it is empty', () => {
  /**
   * `--budget 1` cut every candidate before a single judgement, and the page said
   * "no point survived both a check against the code and the bar for being worth
   * reading" — a verdict on the repository for something the command line did.
   */
  const budgetDoc = () => {
    // `reportOf()` is the English fixture; the Chinese assertion asks for Chinese.
    const doc: ReportInput = { ...reportOf(), lang: 'zh' }
    doc.points = []
    doc.skipped = ['6 candidates cut by token budget (1 tokens)', 'src/a.ts:1 cut by token budget']
    return doc
  }

  it('names the budget when it cut everything, in both languages', () => {
    const zh = renderMarkdown(budgetDoc())
    expect(zh).toContain('预算')
    expect(zh).toContain('`--budget`')

    const en = renderMarkdown({ ...budgetDoc(), lang: 'en' })
    expect(en).toContain('token budget cut every one')
    expect(HAN.test(en.split('\n').filter((line) => line.includes('budget')).join('\n'))).toBe(false)
  })

  it('keeps the ordinary wording when the reason is not the budget', () => {
    const doc: ReportInput = { ...reportOf(), lang: 'zh' }
    doc.points = []
    doc.skipped = ['src/a.ts:1 model reply content is not JSON']
    const zh = renderMarkdown(doc)
    expect(zh).not.toContain('`--budget`')
    expect(zh).toContain('这次没有找到')
  })
})
