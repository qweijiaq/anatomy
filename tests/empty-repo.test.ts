/**
 * The repository with nothing to teach is the case a user is most likely to hit
 * first: a fresh project whose only file is a README.
 *
 * The run must still finish and still write a page — an empty result is an
 * answer, not an error — and the page must say why it is empty instead of
 * rendering a shell that looks like a failed analysis.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runAnalyze } from '../src/commands/analyze.js'
import { cleanupTemporaryDirs, fakeClient, temporaryDir } from './helpers/run-fixture.js'

afterAll(() => {
  cleanupTemporaryDirs()
})

/** A repository whose only content is a README: nothing to analyse. */
function readmeOnlyRepo(): string {
  const repo = path.join(temporaryDir('ana-empty-'), 'empty-repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(path.join(repo, 'README.md'), '# empty-repo\n\nA placeholder.\n')
  return repo
}

describe('runAnalyze on a repository with nothing but a README', () => {
  it('still writes a report and explains the empty result', async () => {
    const baseDir = temporaryDir('ana-empty-out-')
    const repo = readmeOnlyRepo()

    const result = await runAnalyze(repo, { baseDir, client: fakeClient() })

    expect(result.runId).not.toBe('')
    expect(existsSync(result.reportPath)).toBe(true)

    const markdown = await readFile(result.reportPath, 'utf8')
    expect(markdown).toContain('没找到值得学的点')

    const tail = markdown.slice(markdown.indexOf('## 没看的部分'))
    expect(tail).toContain('跳过：')
    expect(tail.split('\n').some((line) => line.startsWith('- 跳过：'))).toBe(true)
  })
})
