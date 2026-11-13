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

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { forget, parseForgetArgs } from '../src/commands/forget.js'

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
    expect(parseForgetArgs(['abc123'])).toEqual({ id: 'abc123', target: 'run' })
    expect(parseForgetArgs(['abc123', '--app'])).toEqual({ id: 'abc123', target: 'app' })
    expect(parseForgetArgs(['abc123', '--dir', '/tmp/x'])).toEqual({
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
