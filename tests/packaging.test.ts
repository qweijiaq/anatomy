/**
 * What the package would actually ship.
 *
 * `bin` points at `dist/cli.js`, so the published thing is the built CLI. Without a
 * `files` list npm ships whatever is not gitignored — measured here at 336 files,
 * including 73 test files and 64 eval fixtures. A package whose install pulls down
 * its own test suite is not a package, it is a checkout.
 *
 * The check is a dry run rather than a manifest assertion: `npm pack` is the thing
 * that decides, so the test asks it.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/** Every path `npm pack` would include, from its dry-run listing. */
function packed(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
  return (parsed[0]?.files ?? []).map((file) => file.path)
}

describe('what npm would publish', () => {
  it('ships the built CLI and the text, not the working tree', () => {
    const files = packed()
    const outside = files.filter(
      (file) =>
        !file.startsWith('dist/') &&
        !['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE'].includes(file),
    )
    // Anything else is a decision someone has to make deliberately.
    expect(outside).toEqual([])
  })

  it('never ships tests, fixtures or eval data', () => {
    const files = packed()
    for (const prefix of ['tests/', 'eval/', 'renderer/', 'docs/', 'electron/']) {
      expect(files.some((file) => file.startsWith(prefix)), `${prefix} is in the tarball`).toBe(false)
    }
  })

  it('ships the Python sidecar the structure stage needs', () => {
    // Copied into dist by `npm run build`; without it `ana analyze` on a Python
    // repository fails at runtime for anyone who installed the package.
    expect(packed()).toContain('dist/kernel/structure/python_index.py')
  })
})
