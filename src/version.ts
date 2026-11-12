/**
 * The engine version, read from `package.json`.
 *
 * It has its own module because two layers need it and one of them must not reach
 * for the other: `runId` is derived from (sha, ref, subpath, engine version), so the
 * kernel pipeline cannot be assembled without it, while the CLI needs it for
 * `--version`. Importing the CLI from the kernel would be a cycle; importing the
 * package manifest twice would be two sources of truth for the same fact.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function readVersion(): string {
  const pkg = require('../package.json') as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no "version" field')
  }
  return pkg.version
}
