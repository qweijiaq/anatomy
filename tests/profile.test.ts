import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { profileRepo } from '../src/kernel/profile.js'
import { selectScope } from '../src/kernel/scope.js'

// --- fixtures -------------------------------------------------------------

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'anatomy-profile-'))
  created.push(dir)
  return dir
}

async function write(root: string, relative: string, body: string): Promise<void> {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body)
}

/** Writes `files` (path -> content) into a fresh temp repository. */
async function repoOf(files: Record<string, string>): Promise<string> {
  const root = await tempDir()
  for (const [relative, body] of Object.entries(files)) await write(root, relative, body)
  return root
}

/** The scope and profile of the same tree, which is how the kernel uses it. */
async function profileOf(root: string) {
  return profileRepo(root, await selectScope(root))
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * The canonical fixture: a package.json with both `bin` and `main`, a pyproject
 * with script declarations, a tests/ directory with a test file, a CI workflow,
 * a README, and a Rust file that anatomy cannot read but must not hide.
 */
const standardFiles = (): Record<string, string> => ({
  'package.json':
    JSON.stringify(
      {
        name: 'widget',
        bin: { ana: './bin/ana.js' },
        main: 'src/index.ts',
        scripts: { postinstall: 'node ./scripts/boom.js' },
      },
      null,
      2,
    ) + '\n',
  'pyproject.toml': '[project]\nname = "widget"\n\n[project.scripts]\nwidget = "widget.cli:main"\n',
  'src/index.ts': 'export const widget = 1\n',
  'src/util.ts': 'export const util = 2\n',
  'bin/ana.js': '#!/usr/bin/env node\n',
  'tests/profile.test.ts': "it('works', () => {})\n",
  '.github/workflows/ci.yml': 'on: push\n',
  'README.md': '# widget\n',
  'crates/core.rs': 'fn main() {}\n',
  'crates/Cargo.toml': '[package]\nname = "core"\n',
  'crates/inner/go.mod': 'module example.com/core\n',
})

// --- tests ----------------------------------------------------------------

describe('profileRepo', () => {
  it('reads manifests, entry points, tests, ci and docs out of a real tree', async () => {
    const profile = await profileOf(await repoOf(standardFiles()))

    // Manifests at the root and one level down, repo-relative and sorted; the
    // `crates/inner/go.mod` two levels down is out of reach by design.
    expect(profile.manifests).toEqual(['crates/Cargo.toml', 'package.json', 'pyproject.toml'])

    // bin, then main, then pyproject scripts, then conventions; no duplicates.
    expect(profile.entryPoints).toEqual(['bin/ana.js', 'src/index.ts', 'pyproject.toml'])

    expect(profile.hasTests).toBe(true)
    expect(profile.hasCi).toBe(true)
    expect(profile.hasDocs).toBe(true)
    expect(profile.languages).toEqual({ ts: 3, js: 1 })
    // 1 of 11 kept files is Rust; markdown/toml/json are not "languages".
    expect(profile.notes).toEqual(['unanalysed language: rust (9%)'])
  })

  it('never throws on an empty repository', async () => {
    const root = await tempDir()
    const profile = await profileOf(root)

    expect(profile).toMatchObject({
      languages: {},
      manifests: [],
      entryPoints: [],
      hasTests: false,
      hasCi: false,
      hasDocs: false,
    })
    expect(profile.notes).toEqual(['no analysable files found'])
  })

  it('records a malformed package.json as a note instead of failing', async () => {
    const profile = await profileOf(
      await repoOf({ 'package.json': '{"name": "widget", "bin": }\n', 'README.md': '# w\n' }),
    )

    expect(profile.manifests).toEqual(['package.json'])
    expect(profile.entryPoints).toEqual([])
    expect(profile.notes).toHaveLength(1)
    expect(profile.notes[0]).toMatch(/^could not parse package\.json: .+/)
  })

  it('records a malformed pyproject.toml as a note instead of failing', async () => {
    const profile = await profileOf(
      await repoOf({ 'pyproject.toml': '[project]\nname = "widget"\n[project.scripts\n' }),
    )

    expect(profile.manifests).toEqual(['pyproject.toml'])
    expect(profile.entryPoints).toEqual([])
    expect(profile.notes).toHaveLength(1)
    expect(profile.notes[0]).toMatch(/^could not parse pyproject\.toml: .+/)
  })

  it('reads multi-line arrays and strings in pyproject.toml without complaint', async () => {
    const pyproject = [
      '[project]',
      'name = "widget"',
      'dependencies = [',
      '  "requests>=2",  # an inline comment',
      '  "click",',
      ']',
      'description = """',
      'multi line',
      '"""',
      '',
      '[tool.poetry.scripts]',
      'widget = "widget.cli:main"',
      '',
    ].join('\n')

    const profile = await profileOf(await repoOf({ 'pyproject.toml': pyproject }))
    expect(profile.notes).toEqual([])
    expect(profile.entryPoints).toEqual(['pyproject.toml'])
  })

  it('records bin as a string, and only entry points that exist in the scope', async () => {
    const inside = await repoOf({
      'package.json': JSON.stringify({ name: 'w', bin: 'cli.js', main: './src/main.js' }),
      'cli.js': '#!/usr/bin/env node\n',
      'src/main.js': 'export const main = 1\n',
    })
    expect((await profileOf(inside)).entryPoints).toEqual(['cli.js', 'src/main.js'])

    // A declared target that is not part of the analysed scope (build output,
    // a path that does not exist) is not an entry point of the analysis.
    const outside = await repoOf({
      'package.json': JSON.stringify({ name: 'w', bin: { w: './dist/cli.js' }, main: 'missing.js' }),
    })
    expect((await profileOf(outside)).entryPoints).toEqual([])
  })

  it('names an unsupported language at or above five percent of kept files', async () => {
    const files: Record<string, string> = { 'core.rs': 'fn main() {}\n' }
    for (let index = 0; index < 19; index += 1) {
      files[`src/f${index}.ts`] = 'export const x = 1\n'
    }

    expect((await profileOf(await repoOf(files))).notes).toEqual(['unanalysed language: rust (5%)'])
  })

  it('stays quiet about an unsupported language below five percent', async () => {
    const files: Record<string, string> = { 'core.rs': 'fn main() {}\n' }
    for (let index = 0; index < 20; index += 1) {
      files[`src/f${index}.ts`] = 'export const x = 1\n'
    }

    expect((await profileOf(await repoOf(files))).notes).toEqual([])
  })

  it('reports every dominant unanalysed language, largest first', async () => {
    const files = {
      'a.go': 'package main\n',
      'b.go': 'package main\n',
      'c.go': 'package main\n',
      'd.rs': 'fn main() {}\n',
      'e.rs': 'fn main() {}\n',
      'src/index.ts': 'export const x = 1\n',
    }

    expect((await profileOf(await repoOf(files))).notes).toEqual([
      'unanalysed language: go (50%)',
      'unanalysed language: rust (33%)',
    ])
  })

  it('detects test files by name and by a tests/ directory', async () => {
    const withTests = async (files: Record<string, string>): Promise<boolean> =>
      (await profileOf(await repoOf(files))).hasTests

    expect(await withTests({ 'src/widget.test.ts': '' })).toBe(true)
    expect(await withTests({ 'src/widget_test.py': '' })).toBe(true)
    expect(await withTests({ 'test_widget.py': '' })).toBe(true)
    expect(await withTests({ 'tests/whatever.md': 'notes\n' })).toBe(true)
    expect(await withTests({ 'src/main.ts': 'export const x = 1\n' })).toBe(false)
  })

  it('takes __main__.py and a bin/ directory as entry points', async () => {
    const root = await repoOf({
      '__main__.py': 'print("hi")\n',
      'bin/tool': '#!/bin/sh\n',
      'bin/nested/deep.sh': '#!/bin/sh\n',
    })
    expect((await profileOf(root)).entryPoints).toEqual(['__main__.py', 'bin/tool'])
  })

  it('ignores manifests inside dependency and build directories', async () => {
    const profile = await profileOf(
      await repoOf({
        'vendor/package.json': '{"name": "v"}',
        'dist/package.json': '{"name": "d"}',
        'node_modules/left-pad/package.json': '{"name": "l"}',
        'src/index.ts': 'export const x = 1\n',
      }),
    )

    expect(profile.manifests).toEqual([])
  })

  it('never executes anything it finds in the repository', async () => {
    const root = await repoOf({
      'package.json': JSON.stringify({
        name: 'evil',
        bin: 'bin/evil.js',
        scripts: { postinstall: 'node bin/evil.js' },
      }),
      'bin/evil.js': "require('node:fs').writeFileSync('PWNED', 'x')\n",
      'setup.py': "open('PWNED', 'w').write('x')\n",
    })

    const profile = await profileOf(root)
    expect(profile.entryPoints).toEqual(['bin/evil.js'])
    expect(await exists(path.join(root, 'PWNED'))).toBe(false)
  })

  it('is deterministic', async () => {
    const root = await repoOf(standardFiles())
    expect(await profileOf(root)).toEqual(await profileOf(root))
  })
})
