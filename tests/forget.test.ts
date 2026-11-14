/**
 * Deleting a stored analysis.
 *
 * The dangerous failure here is not "does not delete" — it is "deletes the wrong
 * thing". So the refusal cases are tested at least as hard as the happy path: an id
 * that could escape its directory must be rejected before anything touches the
 * filesystem, and "not there" must not be reported as a failure.
 *
 * `isArtifactName` is shared with the read path on purpose: an id that cannot be
 * read is not an id that can be deleted.
 */

import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { forget, keepRecent, parseForgetArgs } from '../src/commands/forget.js'

async function runWithDirs(): Promise<{ base: string; id: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'ana-forget-'))
  const id = '0c1cd4e7b0ec'
  await mkdir(path.join(base, id))
  await writeFile(path.join(base, id, 'manifest.json'), '{}')
  return { base, id }
}

describe('forget', () => {
  it('removes the run directory and nothing else', async () => {
    const { base, id } = await runWithDirs()
    await mkdir(path.join(base, 'keep-me'))

    const result = await forget(id, { baseDir: base })

    expect(result).toEqual({ removed: path.join(base, id) })
    expect(await readdir(base)).toEqual(['keep-me'])
  })

  it('refuses an id that could escape the base directory', async () => {
    const { base } = await runWithDirs()
    for (const id of ['..', '.', '../etc', 'a/b', '/etc/passwd', '']) {
      await expect(forget(id, { baseDir: base })).rejects.toThrow()
    }
    // Nothing above moved: the directory still holds its run.
    expect(await readdir(base)).toEqual(['0c1cd4e7b0ec'])
  })

  it('calls a second delete of the same id a no-op rather than a failure', async () => {
    const { base, id } = await runWithDirs()
    await forget(id, { baseDir: base })
    expect(await forget(id, { baseDir: base })).toEqual({ missing: true })
  })

  it('refuses to delete a file that happens to share the name', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ana-forget-'))
    await writeFile(path.join(base, 'a-run'), '{}')
    await expect(forget('a-run', { baseDir: base })).rejects.toThrow()
  })
})

describe('parseForgetArgs', () => {
  it('reads the id, the base choice and an explicit directory', () => {
    expect(parseForgetArgs(['abc123'])).toEqual({ mode: 'one', id: 'abc123', target: 'run' })
    expect(parseForgetArgs(['abc123', '--app'])).toEqual({ mode: 'one', id: 'abc123', target: 'app' })
    expect(parseForgetArgs(['abc123', '--dir', '/tmp/x'])).toEqual({
      mode: 'one',
      id: 'abc123',
      target: 'run',
      baseDir: '/tmp/x',
    })
  })

  it('refuses two ids at once, so a typo cannot widen the delete', () => {
    expect(() => parseForgetArgs(['a', 'b'])).toThrow()
    expect(() => parseForgetArgs([])).toThrow()
    expect(() => parseForgetArgs(['--nope'])).toThrow()
  })
})

describe('keepRecent', () => {
  /**
   * The store had no upper bound. A person who runs `ana analyze` while learning the
   * tool kept all of them: this working copy reached 282 run directories, 1454 files,
   * before anything removed one. `forget` could delete a run but only by naming it.
   *
   * Order comes from each run's `manifest.json` mtime, because a run id is a digest
   * and its name carries no time at all.
   */
  async function storeOf(count: number): Promise<{ base: string; ids: string[] }> {
    const base = await mkdtemp(path.join(tmpdir(), 'ana-keep-'))
    const ids: string[] = []
    for (let index = 0; index < count; index += 1) {
      const id = `run${String(index).padStart(10, '0')}`
      ids.push(id)
      await mkdir(path.join(base, id))
      const manifest = path.join(base, id, 'manifest.json')
      await writeFile(manifest, '{}')
      // Newer index, newer stamp: the id order and the age order deliberately agree
      // here, and the next test breaks that symmetry on purpose.
      const stamp = new Date(Date.UTC(2026, 0, 1 + index))
      await utimes(manifest, stamp, stamp)
    }
    return { base, ids }
  }

  it('keeps the newest n and removes the rest', async () => {
    const { base, ids } = await storeOf(5)
    const swept = await keepRecent(2, { baseDir: base })

    expect(await readdir(base)).toEqual(ids.slice(3))
    expect(swept.kept).toHaveLength(2)
    expect(swept.removed).toHaveLength(3)
  })

  it('orders by manifest age, not by id', async () => {
    const { base, ids } = await storeOf(3)
    // Make the alphabetically first run the newest one.
    const newest = path.join(base, ids[0] as string, 'manifest.json')
    await utimes(newest, new Date('2026-12-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'))

    const swept = await keepRecent(1, { baseDir: base })
    expect(await readdir(base)).toEqual([ids[0]])
    expect(swept.removed).toHaveLength(2)
  })

  it('treats a run with no manifest as the oldest thing to delete', async () => {
    const { base, ids } = await storeOf(2)
    await mkdir(path.join(base, 'interrupted0000'))
    const swept = await keepRecent(2, { baseDir: base })
    expect(await readdir(base)).toEqual(ids)
    expect(swept.removed.join(' ')).toContain('interrupted0000')
  })

  it('refuses to keep nothing', async () => {
    const { base } = await storeOf(1)
    await expect(keepRecent(0, { baseDir: base })).rejects.toThrow(/至少是 1/)
  })

  it('answers an empty or missing directory without failing', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ana-keep-empty-'))
    expect(await keepRecent(3, { baseDir: base })).toEqual({ removed: [], kept: [] })
    expect(await keepRecent(3, { baseDir: path.join(base, 'nope') })).toEqual({ removed: [], kept: [] })
  })

  it('leaves a directory whose name could not be an artifact alone', async () => {
    const { base } = await storeOf(2)
    // `ARTIFACT_NAME` requires an alphanumeric first character, so a leading dot is
    // the name no run can have — and therefore not one this command may delete.
    await mkdir(path.join(base, '.staging'))
    await keepRecent(1, { baseDir: base })
    expect(await readdir(base)).toContain('.staging')
  })
})

describe('parseForgetArgs with --keep', () => {
  it('reads the count and the directory', () => {
    expect(parseForgetArgs(['--keep', '3', '--dir', '/tmp/x'])).toEqual({
      mode: 'keep',
      keep: 3,
      baseDir: '/tmp/x',
    })
  })

  it('refuses an id beside --keep, so one command cannot mean two things', () => {
    expect(() => parseForgetArgs(['abc', '--keep', '2'])).toThrow(/不接受 id/)
  })

  it('refuses a count below one, and a count that is not a number', () => {
    expect(() => parseForgetArgs(['--keep', '0'])).toThrow(/至少是 1/)
    expect(() => parseForgetArgs(['--keep', 'two'])).toThrow(/至少是 1/)
    expect(() => parseForgetArgs(['--keep'])).toThrow(/需要一个数字/)
  })

  it('refuses --keep together with --app', () => {
    expect(() => parseForgetArgs(['--keep', '2', '--app'])).toThrow(/只作用于 run/)
  })
})
