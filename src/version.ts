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
function manifestPath(): string {
  const candidates = [process.cwd(), ...(typeof __dirname === 'string' ? [__dirname, path.join(__dirname, '..')] : [])]
  for (const base of candidates) {
    const candidate = path.join(base, 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }
      if (parsed.name === 'anatomy') return candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error('package.json not found for the anatomy engine')
}

export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(manifestPath(), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no "version" field')
  }
  return pkg.version
}
