/**
 * The facts report.
 *
 * It has no verifier behind it — there is no source to compare against — so the
 * only guarantee it can offer is that every statement is a field and every number
 * carries its caveat. Both are pinned here.
 */

import { describe, expect, it } from 'vitest'

import type { AppSurvey } from '../src/app/rea.js'
import { renderAppReport } from '../src/render/app-report.js'

function surveyOf(overrides: Partial<AppSurvey> = {}): AppSurvey {
  return {
    evidenceId: 'ev_test',
    confidence: 'derived',
    authority: 'shipped-artifact',
    target: '/tmp/app',
    name: 'demo',
    format: 'directory',
    digest: 'abc123',
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
    limitations: ['Graph coverage is incomplete.'],
    modules: [
      {
        id: 'n1',
        kind: 'context-bridge-api',
        label: 'api',
        artifact: 'a',
        labels: ['api'],
        members: ['app.read', 'app.save'],
        operation: '',
      },
    ],
    relations: [],
    groups: {
      channels: { privileged: [], write: ['x:save'], read: ['x:read'], event: [], other: [] },
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

describe('renderAppReport', () => {
  it('states what it is, so the reader knows no model wrote it', () => {
    const md = renderAppReport(surveyOf())
    expect(md).toContain('事实报告')
    expect(md).toContain('没有模型参与')
    expect(md).toContain('ev_test')
  })

  it('keeps the caveat next to the counters instead of at the bottom', () => {
    const md = renderAppReport(surveyOf())
    const tableAt = md.indexOf('| 窗口 |')
    const caveatAt = md.indexOf('上面每个数字都是**下界**')
    expect(tableAt).toBeGreaterThan(-1)
    expect(caveatAt).toBeGreaterThan(tableAt)
    // And before the next heading, so it cannot be read as belonging to something else.
    expect(caveatAt).toBeLessThan(md.indexOf('## 渲染进程拿到了什么'))
  })

  it('names the unpaired channels and says absence is not proof', () => {
    const md = renderAppReport(surveyOf())
    expect(md).toContain('`x:read`')
    expect(md).toContain('`x:save`')
    expect(md).toContain('「没找到接收端」不等于「没有接收端」')
  })

  it('labels the grouping as a reading of names, not a security verdict', () => {
    const md = renderAppReport(surveyOf())
    expect(md).toContain('分组只读名字')
    expect(md).toContain('**会改东西**（1）')
  })

  it('omits the bridge section when nothing was exposed', () => {
    const md = renderAppReport(surveyOf({ modules: [] }))
    expect(md).not.toContain('## 渲染进程拿到了什么')
  })

  it('says a retry happened, and where', () => {
    const md = renderAppReport(
      surveyOf({ retried: true, retryNote: '第一次全量分析把 worker 堆撑爆了。' }),
    )
    expect(md).toContain('自动缩小过范围')
    expect(md).toContain('第一次全量分析把 worker 堆撑爆了。')
  })

  it('reproduces every limitation verbatim', () => {
    const limitations = ['A statement REA made.', 'Another one.']
    const md = renderAppReport(surveyOf({ limitations }))
    for (const item of limitations) expect(md).toContain(item)
  })
})
