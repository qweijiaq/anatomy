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

describe('the installed package actually runs', () => {
  /**
   * Found by installing the tarball rather than by reading it.
   *
   * `readVersion()` located `package.json` from `process.cwd()` and `__dirname`.
   * `dist/cli.js` is ESM, where `__dirname` is undefined, so an installed `ana` run
   * from any other directory threw `package.json not found for the anatomy engine` —
   * which is every invocation of an installed CLI. The package looked fine, packed
   * fine, and could not run.
   */
  it('resolves the engine manifest from the module, not the working directory', async () => {
    const versionModule = await import('../src/version.js')
    const fromElsewhere = process.cwd()
    try {
      process.chdir(require('node:os').tmpdir())
      // The important property: it does not depend on where the process was started.
      expect(versionModule.readVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      process.chdir(fromElsewhere)
    }
  })
})

describe('runtime dependencies', () => {
  /**
   * `dependencies` is what `npm install anatomy` downloads. It held `electron`,
   * `vite`, `react`, `react-dom` and three `@types` packages — the entire desktop UI
   * toolchain, several hundred megabytes, for a CLI whose bundled code imports two
   * packages. The tarball's own manifest looked unremarkable; the install did not.
   */
  it('contains only what the shipped code imports', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const deps = Object.keys((JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }).dependencies)

    // Everything `src/` — the code that becomes `dist/` — imports from outside Node.
    const imported = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(absolute)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const source = readFileSync(absolute, 'utf8')
        for (const match of source.matchAll(/from '([^.][^']*)'/g)) {
          const specifier = match[1] as string
          if (specifier.startsWith('node:')) continue
          imported.add(specifier.split('/')[0] as string)
        }
      }
    }
    walk(path.join(ROOT, 'src'))

    for (const name of imported) {
      expect(deps, `src/ imports ${name} but it is not a runtime dependency`).toContain(name)
    }
    // And nothing heavy rides along silently.
    for (const name of ['electron', 'vite', 'react', 'react-dom']) {
      expect(deps, `${name} must not be a runtime dependency of a CLI`).not.toContain(name)
    }
  })
})
