import { cpSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { canonicalizeFile } from '../src/kernel/canonicalize.js'
import { detectLanguage, ScopeLimitError, selectScope } from '../src/kernel/scope.js'
import { cleanupTemporaryDirs, temporaryDir } from './helpers/run-fixture.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/repo-small/', import.meta.url)).replace(
  /\/$/,
  '',
)

/**
 * The scope is measured against a copy of the fixture repository with one
 * generated large file in it.
 *
 * The `large-fixture` rule needs a file over 1 MiB, and committing that blob
 * would put the only megabyte-sized binary in this repository for the sake of a
 * single threshold. Generating it at test time keeps the rule exercised and the
 * repository free of it.
 */
const root = temporaryDir('ana-scope-')
afterAll(cleanupTemporaryDirs)
cpSync(fixtureRoot, root, { recursive: true })
mkdirSync(path.join(root, 'tests', 'fixtures'), { recursive: true })
// Text, not zeros: a NUL-filled file would trip the binary rule first and the
// `large-fixture` case would go untested.
writeFileSync(path.join(root, 'tests', 'fixtures', 'big.bin'), Buffer.alloc(1_210_000, 'x'))

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
    // root .gitignore: `/scratch.ts` is anchored at the repository root, so only the
    // root-level file goes. Same-named files deeper down are real source and must
    // survive; a matcher that strips the leading `/` first would prune them.
    expect(kept).not.toContain('scratch.ts')
    expect(kept).toContain('src/scratch.ts')
    expect(kept).toContain('src/nested/deeper/scratch.ts')
    // src/nested/.gitignore holds `/scratch.ts`, anchored to src/nested only.
    expect(kept).not.toContain('src/nested/scratch.ts')

    // debug.log, src/ignored-by-git.ts, scratch.ts, src/nested/scratch.ts.
    expect(reasonCount(scope, 'gitignore')).toBe(4)
  })

  it('drops binaries but not text fixtures, and drops large fixtures by size', async () => {
    const scope = await selectScope(root)
    expect(scope.files.some((f) => f.path === 'assets/logo.bin')).toBe(false)
    expect(scope.files.some((f) => f.path === 'tests/fixtures/big.bin')).toBe(false)
    expect(reasonCount(scope, 'binary')).toBe(1)
    expect(reasonCount(scope, 'large-fixture')).toBe(1)
  })

  it('reports version-control bookkeeping as its own reason, not as vendored code', async () => {
    // A checkout always has `.git`, and the report header prints these counts
    // verbatim: calling it vendored tells the reader the project contains
    // third-party code it does not.
    const withGit = temporaryDir('ana-scope-git-')
    cpSync(fixtureRoot, withGit, { recursive: true })
    mkdirSync(path.join(withGit, '.git'), { recursive: true })
    writeFileSync(path.join(withGit, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(path.join(withGit, 'tests', 'fixtures'), { recursive: true })
    writeFileSync(path.join(withGit, 'tests', 'fixtures', 'big.bin'), Buffer.alloc(1_210_000, 'x'))

    const scope = await selectScope(withGit)

    expect(reasonCount(scope, 'vcs')).toBe(1)
    expect(scope.excluded.find((entry) => entry.reason === 'vendored')?.count ?? 0).toBe(
      reasonCount(await selectScope(root), 'vendored'),
    )
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
    // 23 files on disk: 13 kept + 10 excluded, none counted twice.
    expect(scope.excluded.reduce((sum, entry) => sum + entry.count, 0)).toBe(10)
    expect(scope.totals.files + 10).toBe(23)
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
      'src/nested/deeper/scratch.ts',
      'src/scratch.ts',
      'src/util.ts',
      'tests/deeper/.gitignore',
      'tests/deeper/keep.ts',
      'tests/greet.test.ts',
    ])
    expect(scope.byLanguage['ts']).toBe(6)
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
  // Every limit test breaches on a candidate that is *not* the first one, and asserts
  // `actual` — the progress the walk had made. A limitation checked only after a full
  // traversal would report the final totals instead (and would be full-walk numbers
  // far above the limit), so these tests cannot pass for such an implementation.

  it('fails fast on file count, partway through the walk', async () => {
    const full = await selectScope(root)
    const limit = 6
    // The 7th kept file is somewhere in the middle of the tree, after 6 kept files.
    expect(full.totals.files).toBeGreaterThan(limit + 1)

    const attempt = selectScope(root, { limits: { maxFiles: limit, maxBytes: 1e9, maxLines: 1e9 } })
    await expect(attempt).rejects.toMatchObject({ dimension: 'files', limit, actual: limit + 1 })
    await expect(attempt).rejects.toBeInstanceOf(ScopeLimitError)
  })

  it('fails fast on bytes, partway through the walk', async () => {
    const full = await selectScope(root)
    const breach = 3 // the 4th kept file in walk order
    const before = full.files.slice(0, breach)
    const prefixBytes = before.reduce((sum, file) => sum + file.bytes, 0)
    const limit = prefixBytes + 1
    const expected = prefixBytes + full.files[breach]!.bytes
    // Breaching on the 4th file is only observable if the walk stopped there.
    expect(full.totals.bytes).toBeGreaterThan(expected)

    await expect(
      selectScope(root, { limits: { maxFiles: 1e9, maxBytes: limit, maxLines: 1e9 } }),
    ).rejects.toMatchObject({ dimension: 'bytes', limit, actual: expected })
  })

  it('fails fast on lines, partway through the walk', async () => {
    const full = await selectScope(root)
    const breach = 3 // the 4th kept file in walk order
    const before = full.files.slice(0, breach)
    const prefixLines = before.reduce((sum, file) => sum + file.lines, 0)
    const limit = prefixLines + 1
    const expected = prefixLines + full.files[breach]!.lines
    expect(full.files[breach]!.lines).toBeGreaterThan(1)
    expect(full.totals.lines).toBeGreaterThan(expected)

    await expect(
      selectScope(root, { limits: { maxFiles: 1e9, maxBytes: 1e9, maxLines: limit } }),
    ).rejects.toMatchObject({ dimension: 'lines', limit, actual: expected })
  })

  it('applies limits to the post-exclusion numbers', async () => {
    // On disk this repository has 23 files; two excluded subtrees leave 3.
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
    expect(paths(scope).sort()).toStrictEqual([
      'src/nested/.gitignore',
      'src/nested/deep.py',
      'src/nested/deeper/scratch.ts',
    ])
    expect(reasonCount(scope, 'gitignore')).toBe(1)
  })

  it('fails loudly on a root that does not exist', async () => {
    const missing = path.join(root, 'does-not-exist-xyz')
    const attempt = selectScope(missing)
    await expect(attempt).rejects.toThrow(/anatomy: root/)
    await expect(attempt).rejects.toThrow(/does-not-exist-xyz/)
  })

  it('fails loudly when the root is a file, not a directory', async () => {
    const fileRoot = path.join(root, 'README.md')
    const attempt = selectScope(fileRoot)
    await expect(attempt).rejects.toThrow(/not a directory/)
    await expect(attempt).rejects.toThrow(/README\.md/)
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
    expect(reasonCount(scope, 'gitignore')).toBe(6)
  })

  it('evaluates extraIgnore after every .gitignore, including nested negations', async () => {
    // tests/deeper/.gitignore holds `*.ts` + `!keep.ts`, so keep.ts is kept by default.
    expect(paths(await selectScope(root))).toContain('tests/deeper/keep.ts')

    // The caller's exclusion is the last word: a nested `!` cannot re-include it.
    const scope = await selectScope(root, { extraIgnore: ['*.ts'] })
    expect(paths(scope)).not.toContain('tests/deeper/keep.ts')
    expect(paths(scope)).not.toContain('src/index.ts')
  })
})

describe('gitignore pattern semantics', () => {
  const kept = async (extraIgnore: string[]) => paths(await selectScope(root, { extraIgnore }))

  it('anchors a leading slash at the base directory, like an inner slash', async () => {
    // `/src/*.ts` is the same anchored pattern as `src/*.ts`.
    const files = await kept(['/src/*.ts'])
    expect(files).not.toContain('src/index.ts')
    expect(files).toContain('src/nested/deep.py')
  })

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
