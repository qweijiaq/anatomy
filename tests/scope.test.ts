import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { canonicalizeFile } from '../src/kernel/canonicalize.js'
import { detectLanguage, ScopeLimitError, selectScope } from '../src/kernel/scope.js'

const root = fileURLToPath(new URL('./fixtures/repo-small/', import.meta.url)).replace(/\/$/, '')

const reasonCount = (scope: Awaited<ReturnType<typeof selectScope>>, reason: string) =>
  scope.excluded.find((entry) => entry.reason === reason)?.count ?? 0

const paths = (scope: Awaited<ReturnType<typeof selectScope>>) => scope.files.map((f) => f.path)

describe('detectLanguage', () => {
  it('maps only the supported source extensions', () => {
    expect(detectLanguage('src/a.ts')).toBe('ts')
    expect(detectLanguage('src/a.tsx')).toBe('tsx')
    expect(detectLanguage('src/a.js')).toBe('js')
    expect(detectLanguage('src/a.jsx')).toBe('jsx')
    expect(detectLanguage('src/a.mjs')).toBe('mjs')
    expect(detectLanguage('src/a.cjs')).toBe('cjs')
    expect(detectLanguage('src/a.py')).toBe('py')
  })

  it('is case-insensitive about the extension', () => {
    expect(detectLanguage('src/a.TS')).toBe('ts')
    expect(detectLanguage('src/a.Py')).toBe('py')
  })

  it('uses the last extension only', () => {
    expect(detectLanguage('src/a.d.ts')).toBe('ts')
    expect(detectLanguage('src/a.ts.bak')).toBeNull()
  })

  it('returns null for everything else', () => {
    expect(detectLanguage('README.md')).toBeNull()
    expect(detectLanguage('package-lock.json')).toBeNull()
    expect(detectLanguage('Makefile')).toBeNull()
    expect(detectLanguage('.gitignore')).toBeNull()
    expect(detectLanguage('src/A.java')).toBeNull()
    expect(detectLanguage('src/a.rb')).toBeNull()
    expect(detectLanguage('src/a.go')).toBeNull()
  })
})

describe('selectScope on the fixture repository', () => {
  it('reports an absolute resolved root', async () => {
    const scope = await selectScope(root)
    expect(path.isAbsolute(scope.root)).toBe(true)
    expect(scope.root).toBe(path.resolve(root))
  })

  it('drops generated output and counts it under `generated`', async () => {
    const scope = await selectScope(root)
    expect(scope.files.some((f) => f.path.startsWith('dist/'))).toBe(false)
    expect(reasonCount(scope, 'generated')).toBeGreaterThan(0)
  })

  it('drops vendored code, including nested package trees', async () => {
    const scope = await selectScope(root)
    expect(scope.files.some((f) => f.path === 'vendor/lib.js')).toBe(false)
    expect(scope.files.some((f) => f.path.startsWith('node_modules/'))).toBe(false)
    expect(reasonCount(scope, 'vendored')).toBeGreaterThan(0)
  })

  it('drops lockfiles', async () => {
    const scope = await selectScope(root)
    expect(scope.files.some((f) => f.path === 'package-lock.json')).toBe(false)
    expect(scope.excluded.find((e) => e.reason === 'lockfile')).toBeTruthy()
    expect(reasonCount(scope, 'lockfile')).toBe(1)
  })

  it('honours .gitignore patterns of each directory, relative to that directory', async () => {
    const scope = await selectScope(root)
    const kept = paths(scope)

    // root .gitignore: `*.log` with a `!important.log` negation.
    expect(kept).not.toContain('debug.log')
    expect(kept).toContain('important.log')
    // root .gitignore: trailing-slash-free anchored pattern.
    expect(kept).not.toContain('src/ignored-by-git.ts')
    // src/nested/.gitignore holds `/scratch.ts`, anchored to src/nested only.
    expect(kept).not.toContain('src/nested/scratch.ts')
    expect(kept).toContain('src/scratch.ts')

    expect(reasonCount(scope, 'gitignore')).toBe(3)
  })

  it('drops binaries but not text fixtures, and drops large fixtures by size', async () => {
    const scope = await selectScope(root)
    expect(scope.files.some((f) => f.path === 'assets/logo.bin')).toBe(false)
    expect(scope.files.some((f) => f.path === 'tests/fixtures/big.bin')).toBe(false)
    expect(reasonCount(scope, 'binary')).toBe(1)
    expect(reasonCount(scope, 'large-fixture')).toBe(1)
  })

  it('counts each excluded file exactly once, under the first matching reason', async () => {
    const scope = await selectScope(root)
    // dist/bundle.min.js is minified, but `dist` is generated and wins.
    expect(reasonCount(scope, 'minified')).toBe(0)
    expect(reasonCount(scope, 'generated')).toBe(1)
    // Only non-zero reasons are reported, and each reason appears once.
    expect(scope.excluded.every((entry) => entry.count > 0)).toBe(true)
    const reasons = scope.excluded.map((entry) => entry.reason)
    expect(new Set(reasons).size).toBe(reasons.length)
    // 19 files on disk: 10 kept + 9 excluded, none counted twice.
    expect(scope.excluded.reduce((sum, entry) => sum + entry.count, 0)).toBe(9)
    expect(scope.totals.files + 9).toBe(19)
  })

  it('keeps the project sources and buckets them by language', async () => {
    const scope = await selectScope(root)
    expect(paths(scope).sort()).toStrictEqual([
      '.gitignore',
      'README.md',
      'important.log',
      'src/component.tsx',
      'src/index.ts',
      'src/nested/.gitignore',
      'src/nested/deep.py',
      'src/scratch.ts',
      'src/util.ts',
      'tests/greet.test.ts',
    ])
    expect(scope.byLanguage['ts']).toBe(4)
    expect(scope.byLanguage['tsx']).toBe(1)
    expect(scope.byLanguage['py']).toBe(1)
    expect(scope.byLanguage['md']).toBeUndefined()
    const readme = scope.files.find((f) => f.path === 'README.md')
    expect(readme?.language).toBeNull()
  })

  it('records the real byte and line sizes of kept files', async () => {
    const scope = await selectScope(root)
    for (const file of scope.files) {
      const abs = path.join(root, file.path)
      const canonical = await canonicalizeFile(abs)
      // Line counts must agree with the canonicalizer, which downstream evidence
      // line numbers are anchored to.
      expect({ path: file.path, lines: file.lines }).toStrictEqual({
        path: file.path,
        lines: canonical.lineCount,
      })
      expect(file.bytes).toBe(statSync(abs).size)
    }
    const index = scope.files.find((f) => f.path === 'src/index.ts')!
    expect(index.bytes).toBeGreaterThan(0)
    expect(index.lines).toBe(5)
    expect(index.language).toBe('ts')
    expect(scope.totals.files).toBe(scope.files.length)
    expect(scope.totals.bytes).toBe(scope.files.reduce((sum, f) => sum + f.bytes, 0))
    expect(scope.totals.lines).toBe(scope.files.reduce((sum, f) => sum + f.lines, 0))
    expect(Object.values(scope.byLanguage).reduce((a, b) => a + b, 0)).toBe(
      scope.files.filter((f) => f.language !== null).length,
    )
  })
})

describe('selectScope limits', () => {
  it('fails fast on file count and names the dimension', async () => {
    const attempt = selectScope(root, { limits: { maxFiles: 1, maxBytes: 1e9, maxLines: 1e9 } })
    await expect(attempt).rejects.toMatchObject({ dimension: 'files', limit: 1 })
    await expect(attempt).rejects.toBeInstanceOf(ScopeLimitError)
  })

  it('fails fast on bytes', async () => {
    await expect(
      selectScope(root, { limits: { maxFiles: 1e9, maxBytes: 1, maxLines: 1e9 } }),
    ).rejects.toMatchObject({ dimension: 'bytes', limit: 1 })
  })

  it('fails fast on lines', async () => {
    await expect(
      selectScope(root, { limits: { maxFiles: 1e9, maxBytes: 1e9, maxLines: 1 } }),
    ).rejects.toMatchObject({ dimension: 'lines', limit: 1 })
  })

  it('applies limits to the post-exclusion numbers', async () => {
    // On disk this repository has 19 files; two excluded subtrees leave 3.
    const scope = await selectScope(root, {
      limits: { maxFiles: 3, maxBytes: 1e9, maxLines: 1e9 },
      extraIgnore: ['src', 'tests'],
    })
    expect(scope.totals.files).toBe(3)
    expect(reasonCount(scope, 'gitignore')).toBeGreaterThan(0)
  })
})

describe('selectScope options', () => {
  it('reports counts only for reasons that actually fired', async () => {
    const scope = await selectScope(root, { subpath: 'src' })
    const reasons = scope.excluded.map((e) => e.reason)
    expect(reasons).toContain('gitignore')
    expect(reasons).not.toContain('generated')
    expect(reasons).not.toContain('lockfile')
  })

  it('restricts the walk to subpath while keeping root-relative paths', async () => {
    const scope = await selectScope(root, { subpath: 'src/nested' })
    expect(paths(scope).sort()).toStrictEqual(['src/nested/.gitignore', 'src/nested/deep.py'])
    expect(reasonCount(scope, 'gitignore')).toBe(1)
  })

  it('rejects a missing subpath with a message that says so', async () => {
    await expect(selectScope(root, { subpath: 'nope' })).rejects.toThrow(/subpath/)
    await expect(selectScope(root, { subpath: '../escape' })).rejects.toThrow(/subpath/)
  })

  it('treats a file as a missing subpath', async () => {
    await expect(selectScope(root, { subpath: 'README.md' })).rejects.toThrow(/subpath/)
  })

  it('applies extraIgnore patterns as if they were gitignore rules at the root', async () => {
    const scope = await selectScope(root, { extraIgnore: ['*.log', 'src/util.ts'] })
    expect(paths(scope)).not.toContain('important.log')
    expect(paths(scope)).not.toContain('src/util.ts')
    expect(paths(scope)).toContain('src/index.ts')
    expect(reasonCount(scope, 'gitignore')).toBe(5)
  })
})

describe('gitignore pattern semantics', () => {
  const kept = async (extraIgnore: string[]) => paths(await selectScope(root, { extraIgnore }))

  it('anchors patterns that contain a slash to the base directory', async () => {
    const files = await kept(['src/*.ts'])
    expect(files).not.toContain('src/index.ts')
    expect(files).toContain('src/nested/deep.py')
  })

  it('matches bare names at any depth', async () => {
    expect(await kept(['util.ts'])).not.toContain('src/util.ts')
  })

  it('expands ** across directory levels', async () => {
    const files = await kept(['**/nested/**'])
    expect(files).not.toContain('src/nested/deep.py')
    expect(files).toContain('src/index.ts')
  })

  it('supports ? for a single character', async () => {
    expect(await kept(['src/?ndex.ts'])).not.toContain('src/index.ts')
  })

  it('treats a trailing slash as directory-only', async () => {
    expect((await kept(['src/'])).some((p) => p.startsWith('src/'))).toBe(false)
  })

  it('keeps the standard comment and negation handling', async () => {
    const files = await kept(['# a comment', '*.log', '!important.log'])
    expect(files).toContain('important.log')
    expect(files).not.toContain('debug.log')
  })
})
