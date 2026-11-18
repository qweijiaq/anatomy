/**
 * The window's decisions, held to their claims without mounting React.
 *
 * Each of these used to live inside `App.tsx`, where a Chinese-only regex or a
 * negative "minutes ago" could not be tested. They are pure here, so the suite can
 * ask the questions a person asks: does an English report show its rate? does a
 * search for a February date match?
 */

import { describe, expect, it } from 'vitest'

import {
  filterRuns,
  formatDelta,
  formatRate,
  tocOf,
  trustOf,
  whenText,
} from '../renderer/src/view-model.js'

const runs = [
  {
    runId: 'a',
    source: 'https://github.com/acme/alpha',
    startedAt: '2026-02-03T10:00:00.000Z',
    points: 4,
    title: 'alpha',
  },
  {
    runId: 'b',
    source: '/tmp/beta',
    startedAt: '2026-03-04T10:00:00.000Z',
    points: 6,
    title: 'beta',
  },
]

describe('trustOf', () => {
  it('reads the Chinese report header', () => {
    const markdown = ['## 可信度', '', '- 已取证点占比：83.3%', '', '## 1. 一个点', ''].join('\n')
    expect(trustOf(markdown)).toEqual({ evidence: '83.3%', points: '1' })
  })

  it('reads the English header, which the rail used to call unknown', () => {
    const markdown = [
      '## How much of this is verifiable',
      '',
      '- Points with followed evidence: 100.0%',
      '',
      '## 1. One point',
      '',
    ].join('\n')
    expect(trustOf(markdown)).toEqual({ evidence: '100.0%', points: '1' })
  })

  it('says unknown when neither language states a rate', () => {
    expect(trustOf('## 1. A point\n').evidence).toBe('未知')
  })
})

describe('filterRuns', () => {
  it('matches the title, the source and the date', () => {
    expect(filterRuns(runs, 'alp').map((run) => run.runId)).toEqual(['a'])
    expect(filterRuns(runs, 'beta').map((run) => run.runId)).toEqual(['b'])
    expect(filterRuns(runs, '2026-03').map((run) => run.runId)).toEqual(['b'])
  })

  it('returns everything when the query is blank', () => {
    expect(filterRuns(runs, '   ')).toHaveLength(2)
  })
})

describe('whenText', () => {
  const now = Date.parse('2026-03-10T12:00:00.000Z')

  it('never prints a negative count when the clock is slightly behind', () => {
    expect(whenText('2026-03-10T12:00:30.000Z', now)).toBe('刚刚')
  })

  it('switches units as the gap grows', () => {
    expect(whenText('2026-03-10T11:30:00.000Z', now)).toBe('30 分钟前')
    expect(whenText('2026-03-10T09:00:00.000Z', now)).toBe('3 小时前')
    expect(whenText('2026-03-08T12:00:00.000Z', now)).toBe('2 天前')
  })
})

describe('formatting a comparison', () => {
  it('formats a rate, and a missing one as a dash', () => {
    expect(formatRate(0.833)).toBe('83.3%')
    expect(formatRate(null)).toBe('—')
  })

  it('says no change instead of a signed zero', () => {
    expect(formatDelta(3, 3, 'count')).toBe('不变')
    expect(formatDelta(3, 5, 'count')).toBe('+2')
    expect(formatDelta(5, 3, 'count')).toBe('−2')
    expect(formatDelta(0.5, 0.75, 'percent')).toBe('+25.0 个百分点')
  })
})

describe('tocOf', () => {
  it('numbers h2 sections in the same order ReportView does', () => {
    const headings = tocOf('# title\n\n## First\n\ntext\n\n## Second\n')
    expect(headings).toEqual([
      { id: 'report-h2-0', text: 'First' },
      { id: 'report-h2-1', text: 'Second' },
    ])
  })
})
