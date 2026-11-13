/**
 * Comparing two surveys.
 *
 * The dangerous output here is a plausible one: two surveys that examined
 * different amounts of the application produce a diff full of phantom removals,
 * and nothing in the rows themselves looks wrong. So the scope check is tested
 * first and hardest.
 */

import { describe, expect, it } from 'vitest'

import { diffSurveys, isEmptyDiff, outOfScope } from '../src/app/diff.js'
import type { AppSurvey } from '../src/app/rea.js'
import { renderAppDiff } from '../src/render/app-diff.js'

function surveyOf(overrides: Partial<AppSurvey> = {}): AppSurvey {
  return {
    evidenceId: 'ev_a',
    confidence: 'derived',
    authority: 'shipped-artifact',
    target: '/tmp/app',
    name: 'demo',
    format: 'directory',
    digest: 'digest-1',
    surface: {
      browserWindows: 0,
      preloadEntrypoints: 1,
      contextBridgeApis: 1,
      exposedApiMembers: 2,
      ipcOperations: 2,
      ipcLiteralChannels: 2,
      ipcMainHandlers: 0,
      rendererTransmissions: 2,
      rendererListeners: 0,
      ambiguousTransmissions: 2,
      senderValidationObservations: 0,
      nativeAddonBindings: 0,
      protocolRegistrations: 0,
      semantics: 'partial',
    },
    statistics: {
      relevantFiles: 3,
      parsedJavaScriptFiles: 1,
      visitedAstNodes: 10,
      findings: 4,
      textBytesRead: 100,
      parseFailures: 0,
    },
    limitations: [],
    modules: [
      {
        id: 'b1',
        kind: 'context-bridge-api',
        label: 'api',
        artifact: 'x',
        labels: ['api'],
        members: ['app.read', 'app.save'],
        operation: '',
      },
    ],
    relations: [],
    groups: {
      channels: { privileged: [], write: [], read: [], event: [], other: [] },
      members: { privileged: [], write: [], read: [], event: [], other: [] },
    },
    pairs: [
      { name: 'x:read', operation: 'invoke', handled: false },
      { name: 'x:save', operation: 'invoke', handled: false },
    ],
    graphOmitted: '',
    retried: false,
    retryNote: '',
    evidenceFile: '/tmp/app/rea-evidence.json',
    reportPath: '/tmp/app/report.md',
    ...overrides,
  }
}

const SELECTED = (count: number): string =>
  `Caller-selected source analysis leaves ${count} inventoried files outside analysis scope. Inventory identity covers the complete artifact; relationships through unselected sources remain unknown.`

describe('outOfScope', () => {
  it('reads the count out of the limitation REA writes', () => {
    expect(outOfScope(surveyOf({ limitations: [SELECTED(4)] }))).toBe(4)
  })

  it('returns null for a pass that examined everything', () => {
    expect(outOfScope(surveyOf({ limitations: ['Graph coverage is incomplete.'] }))).toBeNull()
  })
})

describe('diffSurveys', () => {
  it('refuses to call two different scopes comparable', () => {
    const before = surveyOf({ limits: undefined } as never)
    const after = surveyOf({ limitations: [SELECTED(4)] })
    const diff = diffSurveys(before, after)
    expect(diff.comparable).toBe(false)
    // The warning must name the cause, not just say "different".
    expect(diff.warnings.join(' ')).toContain('分析范围不一样')
  })

  it('warns when only one side fell back to a narrower pass', () => {
    const diff = diffSurveys(surveyOf(), surveyOf({ retried: true, retryNote: '堆爆了' }))
    expect(diff.comparable).toBe(false)
    expect(diff.warnings.join(' ')).toContain('堆耗尽')
  })

  it('flags two surveys of the same build, where every difference is scope', () => {
    const diff = diffSurveys(surveyOf(), surveyOf({ digest: 'digest-1' }))
    expect(diff.sameBuild).toBe(true)
    expect(renderAppDiff(diff)).toContain('同一个构建')
  })

  it('names channels that appeared and disappeared', () => {
    const after = surveyOf({
      digest: 'digest-2',
      pairs: [
        { name: 'x:read', operation: 'invoke', handled: false },
        { name: 'dialog:pick', operation: 'invoke', handled: false },
      ],
    })
    const diff = diffSurveys(surveyOf(), after)
    expect(diff.channels.added).toEqual(['dialog:pick'])
    expect(diff.channels.removed).toEqual(['x:save'])
    expect(diff.channels.kept).toEqual(['x:read'])
  })

  it('names members that appeared and disappeared', () => {
    const after = surveyOf({
      digest: 'digest-2',
      modules: [
        {
          id: 'b1',
          kind: 'context-bridge-api',
          label: 'api',
          artifact: 'x',
          labels: ['api'],
          members: ['app.read', 'app.remove'],
          operation: '',
        },
      ],
    })
    const diff = diffSurveys(surveyOf(), after)
    expect(diff.members.added).toEqual(['app.remove'])
    expect(diff.members.removed).toEqual(['app.save'])
  })

  it('separates a channel gaining a receiver from one losing it', () => {
    const after = surveyOf({
      digest: 'digest-2',
      pairs: [
        { name: 'x:read', operation: 'invoke', handled: true },
        { name: 'x:save', operation: 'invoke', handled: false },
      ],
    })
    const before = surveyOf({
      pairs: [
        { name: 'x:read', operation: 'invoke', handled: false },
        { name: 'x:save', operation: 'invoke', handled: true },
      ],
    })
    const diff = diffSurveys(before, after)
    expect(diff.pairing.gainedReceiver).toEqual(['x:read'])
    expect(diff.pairing.lostReceiver).toEqual(['x:save'])
    // Pairing is a property of the analysis, not the channel: the diff must say so.
    expect(renderAppDiff(diff)).toContain('配对状态不是通道的属性')
  })
})

describe('isEmptyDiff', () => {
  it('is empty for two identical surveys', () => {
    expect(isEmptyDiff(diffSurveys(surveyOf(), surveyOf()))).toBe(true)
  })

  it('is not empty when a counter moved', () => {
    const after = surveyOf()
    after.surface = { ...after.surface, exposedApiMembers: 3 }
    expect(isEmptyDiff(diffSurveys(surveyOf(), after))).toBe(false)
  })
})

describe('renderAppDiff', () => {
  it('puts the warnings before the numbers', () => {
    const diff = diffSurveys(surveyOf(), surveyOf({ limitations: [SELECTED(4)] }))
    const md = renderAppDiff(diff)
    const warnAt = md.indexOf('这两份不完全可比')
    const tableAt = md.indexOf('| 项 | 前 | 后 | 变化 |')
    expect(warnAt).toBeGreaterThan(-1)
    expect(warnAt).toBeLessThan(tableAt)
  })

  it('says a dimension did not change rather than printing an empty list', () => {
    const md = renderAppDiff(diffSurveys(surveyOf(), surveyOf()))
    expect(md).toContain('通道没有变化（共 2 个）')
    expect(md).toContain('成员没有变化（共 2 个）')
  })
})
