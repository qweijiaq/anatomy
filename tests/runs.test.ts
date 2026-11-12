import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RunManifest } from '../src/contracts/types.js'
import { closeRun, openRun } from '../src/store/runs.js'

const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'anatomy-runs-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

const manifest: RunManifest = {
  runId: '0f1e2d3c4b5a',
  source: 'https://github.com/acme/widget',
  ref: 'v1.2.3',
  sha: 'a'.repeat(64),
  subpath: '',
  engineVersion: '0.0.1',
  startedAt: '2026-11-12T03:04:05.000Z',
}

describe('openRun', () => {
  it('creates <baseDir>/<runId>/ with a manifest and an empty tree/', async () => {
    const base = await tempDir()
    const run = await openRun(base, manifest)

    expect(run.dir).toBe(path.join(base, manifest.runId))
    expect(run.treeDir).toBe(path.join(base, manifest.runId, 'tree'))
    expect((await stat(run.dir)).isDirectory()).toBe(true)
    expect((await stat(run.treeDir)).isDirectory()).toBe(true)
    expect(await readdir(run.treeDir)).toEqual([])
    expect(JSON.parse(await readFile(path.join(run.dir, 'manifest.json'), 'utf8'))).toStrictEqual(
      manifest,
    )
  })

  it('is idempotent: reopening the same run keeps the artifacts', async () => {
    const base = await tempDir()
    const first = await openRun(base, manifest)
    await first.write('points', [{ id: 'p1' }])

    const second = await openRun(base, manifest)

    expect(await second.read('points')).toStrictEqual([{ id: 'p1' }])
    expect(await readdir(base)).toStrictEqual([manifest.runId])
  })
})

describe('Run artifacts', () => {
  it('writes and reads JSON artifacts, last write winning', async () => {
    const run = await openRun(await tempDir(), manifest)

    await run.write('points', [1])
    expect(await run.read('points')).toStrictEqual([1])

    await run.write('points', [2])
    expect(await run.read('points')).toStrictEqual([2])

    // Writes are atomic: no temp files survive a successful write.
    const names = await readdir(run.dir)
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(names.sort()).toStrictEqual(['manifest.json', 'points.json', 'tree'])
  })

  it('returns null for a missing artifact and throws on malformed JSON', async () => {
    const run = await openRun(await tempDir(), manifest)

    expect(await run.read('nope')).toBeNull()

    await writeFile(path.join(run.dir, 'broken.json'), '{"half": ', 'utf8')
    await expect(run.read('broken')).rejects.toThrow(/not valid JSON/)
  })

  it('refuses artifact names that could leave the run directory', async () => {
    const base = await tempDir()
    const run = await openRun(base, manifest)

    for (const name of ['../escape', '..', '', 'nested/name', '/etc/passwd', '.hidden']) {
      await expect(run.write(name, 1)).rejects.toThrow(/artifact name/)
      await expect(run.read(name)).rejects.toThrow(/artifact name/)
    }
    expect(await exists(path.join(base, 'escape.json'))).toBe(false)
    expect(await readdir(base)).toStrictEqual([manifest.runId])
  })

  it('refuses to serialise a value JSON cannot represent', async () => {
    const run = await openRun(await tempDir(), manifest)
    await expect(run.write('undef', undefined)).rejects.toThrow(/serialis/)
    expect(await exists(path.join(run.dir, 'undef.json'))).toBe(false)
  })
})

describe('closeRun', () => {
  it('deletes tree/ but keeps the artifacts', async () => {
    const run = await openRun(await tempDir(), manifest)
    await writeFile(path.join(run.treeDir, 'src.ts'), 'export {}\n', 'utf8')

    await closeRun(run)

    expect(await exists(run.treeDir)).toBe(false)
    expect(await run.read('manifest')).toStrictEqual(manifest)
    expect(await exists(path.join(run.dir, 'manifest.json'))).toBe(true)
  })

  it('keeps tree/ when asked, and is safe to call twice', async () => {
    const run = await openRun(await tempDir(), manifest)
    await writeFile(path.join(run.treeDir, 'src.ts'), 'export {}\n', 'utf8')

    await closeRun(run, { keepTree: true })
    expect(await readFile(path.join(run.treeDir, 'src.ts'), 'utf8')).toBe('export {}\n')

    await closeRun(run)
    await closeRun(run)
    expect(await exists(run.treeDir)).toBe(false)
  })
})
