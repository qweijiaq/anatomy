/**
 * `app-report` and `app-diff` take the name `inspect-app` prints.
 *
 * That name is relative to the store — `.ana/apps/<name>-<digest>` — but both commands
 * resolved it against the current directory, so the name the tool had just printed
 * failed with "先跑 ana inspect-app <dir>" for a survey sitting right there. The message
 * told the reader to look in `.ana/apps` while the code looked somewhere else.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runAppReport, runAppDiff } from '../src/commands/inspect-app.js'
import type { AppSurvey } from '../src/app/rea.js'

const original = process.cwd()
afterEach(() => {
  process.chdir(original)
  process.exitCode = 0
})

function survey(name: string, members: number): AppSurvey {
  return {
    evidenceId: 'rea-stub-0001',
    confidence: 'high',
    authority: 'observed',
    target: `/tmp/${name}`,
    name,
    format: 'directory',
    digest: 'abcdef123456',
    surface: {
      browserWindows: 1,
      preloadEntrypoints: 1,
      contextBridgeApis: 1,
      exposedApiMembers: members,
      ipcOperations: 4,
      ipcLiteralChannels: 2,
      ipcMainHandlers: 3,
      rendererTransmissions: 4,
      rendererListeners: 2,
      ambiguousTransmissions: 1,
      senderValidationObservations: 2,
      nativeAddonBindings: 0,
      protocolRegistrations: 1,
      semantics: 'static',
    },
    statistics: {
      relevantFiles: 6,
      parsedJavaScriptFiles: 3,
      visitedAstNodes: 1200,
      findings: 4,
      textBytesRead: 2048,
      parseFailures: 0,
    },
    pairs: [{ name: 'files:read', operation: 'read', handled: true }],
    retried: false,
    retryNote: '',
    modules: [],
    relations: [],
    channels: [],
    groups: {
      channels: { privileged: [], write: [], read: [], event: [], other: [] },
      members: { privileged: [], write: [], read: [], event: [], other: [] },
    },
    limitations: [],
    graphOmitted: '',
    evidenceFile: '',
    reportPath: '',
  } as unknown as AppSurvey
}

async function storeWith(name: string, members: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ana-apps-'))
  const dir = path.join(root, '.ana', 'apps', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'survey.json'), JSON.stringify(survey(name, members)))
  return root
}

describe('the app commands find a survey by the name inspect-app printed', () => {
  it('app-report reads it out of .ana/apps', async () => {
    const root = await storeWith('demo-13d566e18396', 5)
    process.chdir(root)

    let text = ''
    await runAppReport('demo-13d566e18396', { out: { write: (chunk: string) => (text += chunk) } })
    expect(text).toContain('demo')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('app-diff reads both of them the same way', async () => {
    const root = await storeWith('demo-13d566e18396', 5)
    await mkdir(path.join(root, '.ana', 'apps', 'demo-999999999999'), { recursive: true })
    await writeFile(
      path.join(root, '.ana', 'apps', 'demo-999999999999', 'survey.json'),
      JSON.stringify(survey('demo', 6)),
    )
    process.chdir(root)

    let text = ''
    await runAppDiff('demo-13d566e18396', 'demo-999999999999', {
      out: { write: (chunk: string) => (text += chunk) },
    })
    expect(text).toContain('差异')
    expect(text).toContain('暴露成员')
  })

  it('still says so plainly when neither place has one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ana-apps-empty-'))
    process.chdir(root)

    await runAppReport('missing-000000000000', { out: { write: () => {} } })
    expect(process.exitCode).toBe(1)
  })
})
