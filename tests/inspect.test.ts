/**
 * `ana inspect <evidenceId>` is the answer to "I do not believe this citation".
 * The reader has a report, an id from it, and no tree — so the command must find
 * the stored evidence by id alone and print the range plus the snippet the run
 * kept.
 *
 * The tests therefore take an id from a real run whose tree has already been
 * deleted (proving the snippet comes from the artifact, not the source), and
 * then from a second, hand-written run beside it (proving the lookup walks every
 * stored run, not just the newest one).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runAnalyze } from '../src/commands/analyze.js'
import { asLocation, findEvidence, formatEvidence, parseInspectArgs, runInspect } from '../src/commands/inspect.js'
import type { Evidence, LearningPoint } from '../src/contracts/types.js'
import {
  artifact,
  cleanupTemporaryDirs,
  fakeClient,
  fixtureRepo,
  storedRun,
  temporaryDir,
} from './helpers/run-fixture.js'

afterAll(cleanupTemporaryDirs)

/** Every evidence item the run stored, in page order. */
async function storedEvidence(baseDir: string, runId: string): Promise<Evidence[]> {
  const points = await artifact<LearningPoint[]>(baseDir, runId, 'points')
  return points.flatMap((point) => point.theirs.evidence)
}

describe('runInspect', () => {
  it('prints the range and the stored snippet after the tree is gone', async () => {
    const baseDir = temporaryDir('ana-inspect-out-')
    const repo = fixtureRepo()
    const { runId } = await runAnalyze(repo, { baseDir, client: fakeClient() })
    expect(existsSync(path.join(baseDir, runId, 'tree'))).toBe(false)

    const [evidence] = await storedEvidence(baseDir, runId)
    if (evidence === undefined) throw new Error('the fixture run stored no evidence')

    const text = await runInspect(evidence.id, { baseDir })
    const [header] = text.split('\n')

    expect(header).toBe(`${evidence.path}:${evidence.startLine}-${evidence.endLine}`)
    // Not re-read from the source: the source is gone, and the snippet is stored.
    expect(text).toContain(evidence.snippet)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('finds an id in any run under the parent, not only the newest', async () => {
    const baseDir = temporaryDir('ana-inspect-out-')
    const repo = fixtureRepo()
    const { runId } = await runAnalyze(repo, { baseDir, client: fakeClient() })

    const older: Evidence = {
      id: 'older-run-evidence-1',
      path: 'src/a.ts',
      startLine: 12,
      endLine: 14,
      snippet: 'const q: number[] = []\nconst r = q.length\nreturn r',
    }
    // A run written by hand, deliberately sorted after the real one.
    storedRun(baseDir, 'zzz-older-run', { evidence: older })

    const [evidence] = await storedEvidence(baseDir, runId)
    if (evidence === undefined) throw new Error('the fixture run stored no evidence')
    expect(await runInspect(evidence.id, { baseDir })).toContain(evidence.path)

    const text = await runInspect(older.id, { baseDir })
    expect(text).toContain('src/a.ts:12-14')
    expect(text).toContain('const q: number[] = []')
  })

  it('prints to the given writer as well as returning the text', async () => {
    const baseDir = temporaryDir('ana-inspect-out-')
    const evidence: Evidence = {
      id: 'printed-1',
      path: 'src/b.ts',
      startLine: 3,
      endLine: 3,
      snippet: 'export const b = 1',
    }
    storedRun(baseDir, 'printed', { evidence })

    let printed = ''
    const text = await runInspect(evidence.id, {
      baseDir,
      out: { write: (chunk: string) => (printed += chunk) },
    })

    expect(text).toBe('src/b.ts:3-3\nexport const b = 1\n')
    expect(printed).toBe(text)
  })

  it('rejects an unknown id with no such evidence', async () => {
    const baseDir = temporaryDir('ana-inspect-out-')
    storedRun(baseDir, 'one-run')

    await expect(runInspect('no-such-id', { baseDir })).rejects.toThrow(/no such evidence/)
  })

  it('rejects on a parent directory that does not exist', async () => {
    const baseDir = path.join(temporaryDir('ana-inspect-out-'), 'missing')

    await expect(runInspect('any-id', { baseDir })).rejects.toThrow(/no such evidence/)
  })
})

describe('parseInspectArgs', () => {
  it('takes one evidence id', () => {
    expect(parseInspectArgs(['ev-1'])).toEqual({ help: false, evidenceId: 'ev-1' })
  })

  it('answers --help without an id', () => {
    expect(parseInspectArgs(['-h'])).toEqual({ help: true })
  })

  it('refuses a missing id', () => {
    expect(() => parseInspectArgs([])).toThrow(/needs an evidence id/)
  })

  it('refuses a flag it does not have', () => {
    expect(() => parseInspectArgs(['--id', 'ev-1'])).toThrow(/unknown option/)
  })
})

describe('a citation the reader can actually copy', () => {
  /**
   * The report prints `path:start-end` and no page shows the digest id. So the only
   * string a doubting reader could hand to this command was the one form it rejected:
   * `ana inspect lib/store.mjs:7-8` answered "no such evidence" — true, and useless.
   * The command existed to verify the report and could not be reached from it.
   */
  const evidence: Evidence = {
    id: 'aaaa1111-3476f2',
    path: 'lib/store.mjs',
    startLine: 7,
    endLine: 8,
    snippet: "export const FEEDBACK_STATUSES = ['new', 'accepted']",
  }

  it('takes the form the report prints', async () => {
    const baseDir = temporaryDir('ana-inspect-location-')
    storedRun(baseDir, 'run-a', { evidence })

    const text = await runInspect('lib/store.mjs:7-8', { baseDir })
    expect(text).toBe(formatEvidence(evidence))
  })

  it('says which of the two things went wrong', async () => {
    const baseDir = temporaryDir('ana-inspect-miss-')
    storedRun(baseDir, 'run-a', { evidence })

    // A location nothing cites: the right spelling, the wrong lines.
    await expect(runInspect('lib/store.mjs:9999-10000', { baseDir })).rejects.toThrow(/location was given/)
    // A bare string is not a location, so the message must not imply it was one.
    await expect(runInspect('zzzz', { baseDir })).rejects.not.toThrow(/location/)
  })

  it('prefers the most recent run when two cite the same range', async () => {
    const baseDir = temporaryDir('ana-inspect-newest-')
    storedRun(baseDir, 'run-old', { evidence: { ...evidence, id: 'oldold00-111111', snippet: 'old' } })
    storedRun(baseDir, 'run-new', { evidence: { ...evidence, id: 'newnew00-222222', snippet: 'new' } })

    // Ids are digests and sort arbitrarily, so age can only come from the manifest.
    const { utimes } = await import('node:fs/promises')
    await utimes(
      path.join(baseDir, 'run-new', 'manifest.json'),
      new Date('2026-11-01T00:00:00Z'),
      new Date('2026-11-01T00:00:00Z'),
    )
    await utimes(
      path.join(baseDir, 'run-old', 'manifest.json'),
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    )

    const hit = await findEvidence('lib/store.mjs:7-8', { baseDir })
    expect(hit.runId).toBe('run-new')
    expect(hit.evidence.snippet).toBe('new')
  })

  it('parses only a real range', () => {
    expect(asLocation('lib/a.mjs:7-8')).toEqual({ path: 'lib/a.mjs', startLine: 7, endLine: 8 })
    expect(asLocation('0c1cd4e7b0ec-3476f2')).toBeNull()
    expect(asLocation('lib/a.mjs:7')).toBeNull()
    expect(asLocation('lib/a.mjs:0-1')).toBeNull()
    expect(asLocation('lib/a.mjs:9-2')).toBeNull()
  })
})
