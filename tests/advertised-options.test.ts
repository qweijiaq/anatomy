/**
 * Every option the help text promises is an option the code reads.
 *
 * Three defects of exactly this shape turned up in one week, each found by accident:
 * `$ANA_MODEL` was documented in `--help` and overridden by a default before the
 * client could read it; `ANA_REA_NODE` appeared in an error message advising the
 * reader to set it, and nothing ever read it; `forget` could only delete by digest
 * while the store grew to 282 directories. Each was found by using the product, not by
 * a test, which is why they kept surviving a green suite.
 *
 * This is the test that would have caught all three. It is deliberately shallow — it
 * asks whether the name is handled *somewhere*, not whether it is handled correctly —
 * because the defect it exists for is "advertised and inert", not "handled wrongly".
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/** Every TypeScript file under `src/`, as one blob plus per-file paths. */
function sources(): Array<{ file: string; text: string }> {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  const found: Array<{ file: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      found.push({ file: path.relative(ROOT, full), text: readFileSync(full, 'utf8') })
    }
  }
  walk(path.join(ROOT, 'src'))
  return found
}

/** `const SCAN_USAGE = \`…\`` → the template body. */
function usageBlocks(): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = []
  for (const { text } of sources()) {
    for (const match of text.matchAll(/([A-Z_]+USAGE)\s*=\s*`([\s\S]*?)`/g)) {
      blocks.push({ name: match[1] as string, body: match[2] as string })
    }
  }
  return blocks
}

describe('the help text only promises what the code reads', () => {
  const all = sources()
  // The usage blocks are where the promise is made; looking for handling code inside
  // them would always succeed — the flag is written there by definition. The first
  // version of this file did exactly that, and a flag nothing handled passed.
  const codeOnly = all
    .map((item) => item.text.replace(/[A-Z_]+USAGE\s*=\s*`[\s\S]*?`/g, ''))
    .join('\n')

  it('has usage blocks to check', () => {
    // A parse that silently found nothing would make every assertion below vacuous.
    expect(usageBlocks().length).toBeGreaterThanOrEqual(8)
  })

  it('every --flag it advertises is handled', () => {
    const missing: string[] = []
    for (const { name, body } of usageBlocks()) {
      for (const flag of body.matchAll(/--([a-z][a-z-]*)/g)) {
        // Both forms count: a literal comparison, and the bare name used as a key in a
        // flag map (`values.get('lang')`) — which is how the first version of this
        // sweep produced five false alarms.
        const literal = `--${String(flag[1])}`
        const bare = `'${String(flag[1])}'`
        const doubleBare = `"${String(flag[1])}"`
        if (codeOnly.includes(literal) || codeOnly.includes(bare) || codeOnly.includes(doubleBare)) {
          continue
        }
        missing.push(`${name}: --${String(flag[1])}`)
      }
    }
    expect(missing, missing.join(', ')).toEqual([])
  })

  it('every ANA_* variable it names is read from the environment', () => {
    const mentioned = new Set(all.map((item) => item.text).join('\n').match(/ANA_[A-Z_]+/g) ?? [])
    const read = new Set(codeOnly.match(/process\.env\[?'?(ANA_[A-Z_]+)'?\]?/g) ?? [])
    // `pick(cfg.baseUrl, 'ANA_BASE_URL', …)` reads the environment without indexing it,
    // so a name counts as read when it appears as a quoted string too.
    const quoted = new Set((codeOnly.match(/'(ANA_[A-Z_]{3,})'/g) ?? []).map((item) => item.replace(/'/g, '')))
    // `ANA_DEV_SERVER` is read by the electron launcher, which lives outside `src/`.
    const outside = new Set(['ANA_DEV_SERVER', 'ANA_SOURCEMAP'])

    const missing = [...mentioned].filter(
      (name) =>
        !outside.has(name) &&
        ![...read].some((item) => item.includes(name)) &&
        !quoted.has(name),
    )
    expect(missing, `named but never read: ${missing.join(', ')}`).toEqual([])
  })
})
