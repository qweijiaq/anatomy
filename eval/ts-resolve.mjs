/**
 * The missing half of `node --experimental-strip-types` for this repository.
 *
 * Type stripping runs the sources as they are written, and those sources import
 * each other by the `./x.js` names `tsc` emits — no such file exists on disk, so
 * Node reports "Cannot find module .../types.js" for a file that is right there
 * as `types.ts`. Node's own resolution does not remap the extension; this resolve
 * hook does, and only that:
 *
 * - relative specifiers ending in `.js`, from a parent that is itself `.ts`;
 * - and only when the `.js` target is absent while the `.ts` beside it exists,
 *   so a real `.js` file in a dependency is never shadowed.
 *
 * Everything else is delegated to the default resolver unchanged.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RELATIVE = /^\.{1,2}\//

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith('.js') &&
    RELATIVE.test(specifier) &&
    typeof context.parentURL === 'string' &&
    context.parentURL.endsWith('.ts')
  ) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
}
