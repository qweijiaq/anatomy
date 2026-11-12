/**
 * `ana report` renders a stored run, and its whole promise is that "stored" is
 * enough: no network, no kernel stage, and no extracted tree — that directory is
 * deleted when the analysis ends.
 *
 * So these tests run a real analysis, confirm its tree is gone, and then ask for
 * the page again. What they check is fidelity, not just "a string came back":
 * every point the run kept is on the page with the citation a reader can follow,
 * every candidate the budget cut is still named in the tail, and the run
 * directory is byte-for-byte what it was before the render — a re-render that
 * repairs its input would hide a corrupted artifact forever.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runAnalyze } from '../src/commands/analyze.js'
import { parseReportArgs, runReport } from '../src/commands/report.js'
import type { LearningPoint } from '../src/contracts/types.js'
import {
  artifact,
  cleanupTemporaryDirs,
  fakeClient,
  fixtureRepo,
  storedRun,
  temporaryDir,
} from './helpers/run-fixture.js'

afterAll(cleanupTemporaryDirs)

/** Every file under `dir`, as relative path → contents: a run's fingerprint. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true })) {
    const target = path.join(dir, String(entry))
    if (statSync(target).isFile()) files[String(entry)] = readFileSync(target, 'utf8')
  }
  return files
}

/** The point headings the page actually printed. */
function headings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => /^## \d+\. /.test(line))
}

describe('runReport', () => {
  it('re-renders the same points and citations after the tree is gone', async () => {
    const baseDir = temporaryDir('ana-report-out-')
    const repo = fixtureRepo()

    const { runId } = await runAnalyze(repo, { baseDir, client: fakeClient() })
    // The premise of the command: the sources are not there any more.
    expect(existsSync(path.join(baseDir, runId, 'tree'))).toBe(false)

    const points = await artifact<LearningPoint[]>(baseDir, runId, 'points')
    const cited = points.filter((point) => point.theirs.evidence.length > 0)
    expect(cited.length).toBeGreaterThan(0)

    const markdown = await runReport(runId, { baseDir })

    expect(markdown.startsWith('# fixture-repo\n')).toBe(true)
    expect(markdown).toContain('## 这次分析的可信度')
    expect(headings(markdown).length).toBe(cited.length)
    for (const point of cited) {
      expect(markdown).toContain(point.title)
      for (const evidence of point.theirs.evidence) {
        expect(markdown).toContain(`${evidence.path}:${evidence.startLine}-${evidence.endLine}`)
        expect(markdown).toContain(evidence.snippet)
      }
    }
  })

  it('keeps the tail that names what the budget cut', async () => {
    const baseDir = temporaryDir('ana-report-out-')
    const repo = fixtureRepo()
    const { runId } = await runAnalyze(repo, { baseDir, client: fakeClient(), budget: 7_000 })

    const skipped = await artifact<Array<{ path: string; line: number; reason: string }>>(
      baseDir,
      runId,
      'skipped',
    )
    const cut = skipped.filter((entry) => entry.reason === 'cut by token budget')
    expect(cut.length).toBeGreaterThan(0)

    const markdown = await runReport(runId, { baseDir })
    expect(markdown).toContain('## 没看的部分')
    expect(markdown).toContain(`${cut.length} candidates cut by token budget`)
    for (const entry of cut) expect(markdown).toContain(`${entry.path}:${entry.line}`)
  })

  it('does not rewrite the run it reads', async () => {
    const baseDir = temporaryDir('ana-report-out-')
    const repo = fixtureRepo()
    const { runId } = await runAnalyze(repo, { baseDir, client: fakeClient() })

    const before = snapshot(path.join(baseDir, runId))
    await runReport(runId, { baseDir })

    expect(snapshot(path.join(baseDir, runId))).toEqual(before)
  })

  it('writes the markdown to the given writer as well as returning it', async () => {
    const baseDir = temporaryDir('ana-report-out-')
    storedRun(baseDir, 'handwritten')

    let printed = ''
    const markdown = await runReport('handwritten', {
      baseDir,
      out: { write: (chunk: string) => (printed += chunk) },
    })

    expect(markdown.startsWith('# demo\n')).toBe(true)
    expect(printed).toBe(markdown)
  })

  it('rejects an unknown run id with no such run', async () => {
    const baseDir = temporaryDir('ana-report-out-')

    await expect(runReport('deadbeef', { baseDir })).rejects.toThrow(/no such run/)
  })

  it('rejects an id that cannot name a run directory', async () => {
    const baseDir = temporaryDir('ana-report-out-')

    // A traversal attempt is not a run that might exist: it is no run at all.
    await expect(runReport('../escape', { baseDir })).rejects.toThrow(/no such run/)
  })

  it('rejects a run that never completed', async () => {
    const baseDir = temporaryDir('ana-report-out-')
    storedRun(baseDir, 'halfdone', { complete: false })

    await expect(runReport('halfdone', { baseDir })).rejects.toThrow(/no such run/)
  })

  it('rejects a complete run with an artifact missing', async () => {
    const baseDir = temporaryDir('ana-report-out-')
    const dir = storedRun(baseDir, 'truncated')
    rmSync(path.join(dir, 'synthesis.json'))

    await expect(runReport('truncated', { baseDir })).rejects.toThrow(/no such run/)
  })
})

describe('parseReportArgs', () => {
  it('takes one run id', () => {
    expect(parseReportArgs(['abc123'])).toEqual({ help: false, runId: 'abc123' })
  })

  it('answers --help without a run id', () => {
    expect(parseReportArgs(['--help'])).toEqual({ help: true })
  })

  it('refuses a missing run id', () => {
    expect(() => parseReportArgs([])).toThrow(/needs a run id/)
  })

  it('refuses a flag it does not have', () => {
    expect(() => parseReportArgs(['--run', 'abc123'])).toThrow(/unknown option/)
  })
})
