/**
 * The engine version, read from `package.json`.
 *
 * It has its own module because two layers need it and one of them must not reach
 * for the other: `runId` is derived from (sha, ref, subpath, engine version), so the
 * kernel pipeline cannot be assembled without it, while the CLI needs it for
 * `--version`. Importing the CLI from the kernel would be a cycle; importing the
 * package manifest twice would be two sources of truth for the same fact.
 *
 * It reads the manifest through the filesystem rather than `createRequire`, because
 * a bundler rewrites `import.meta.url` to an empty object: the desktop app's bundle
 * would then call `createRequire(undefined)` at module load and the whole app would
 * fail before the first window. A file read is boring and the same everywhere.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where `package.json` sits relative to the running process.
 *
 * Two layouts have to work: the package root when the CLI runs from `dist/` or the
 * sources, and one level further up when the kernel is bundled into the desktop
 * app's `dist-electron/main.cjs`. Walking up from the working directory and from
 * the bundle's own file covers both without depending on `import.meta.url`, which
 * a bundler rewrites to an empty object.
 */
declare const __dirname: string | undefined

/**
 * The directory this module was loaded from, under either module system.
 *
 * `dist/cli.js` is ESM, where `__dirname` does not exist; the desktop bundle is CJS,
 * where `import.meta.url` is rewritten to an empty object by the bundler. Reading
 * whichever one is real covers both. Without this, an installed `ana` looked only at
 * `process.cwd()` and threw `package.json not found for the anatomy engine` whenever
 * it was run from anywhere else — which is always, for an installed package.
 */
function ownDir(): string {
  try {
    // `import.meta.url` is a real URL under ESM and an empty object under the
    // bundler; `fileURLToPath` throws on the latter rather than returning nonsense.
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return typeof __dirname === 'string' ? __dirname : ''
  }
}

function manifestPath(): string {
  const here = ownDir()
  const candidates = [
    process.cwd(),
    // Walk up from the module as well: `dist/version.js` → the package root, and
    // one level further for a nested install layout.
    ...(here === '' ? [] : [here, path.join(here, '..'), path.join(here, '..', '..')]),
    ...(typeof __dirname === 'string'
      ? [__dirname, path.join(__dirname, '..'), path.join(__dirname, '..', '..')]
      : []),
  ]
  for (const base of candidates) {
    const candidate = path.join(base, 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }
      if (parsed.name === 'anatomy') return candidate
    } catch {
      // try the next candidate
    }
  }
  // Naming the places it looked turns "not found" into something a reader can act on:
  // a nested install and a broken one fail the same way otherwise.
  throw new Error(
    `package.json not found for the anatomy engine; looked in ${candidates.map((base) => path.join(base, 'package.json')).join(', ')}`,
  )
}

export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(manifestPath(), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no "version" field')
  }
  return pkg.version
}
