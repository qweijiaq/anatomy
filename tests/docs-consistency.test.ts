/**
 * Numbers in the documentation must match the artifacts that produce them.
 *
 * Two separate reviews found stale figures here: README claimed 60% recall while
 * the only tracked measurement said 46%, and PROGRESS claimed 532 tests and two
 * tsconfigs while the tree had 721 and three. Both are the same failure — a number
 * written once and never tied to its source — and neither showed up in a test.
 *
 * These checks bind each headline number to the file that generates it, so drift
 * becomes a failing test instead of a wrong document.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')

/** `overall candidate recall: 55/90 = 61%` → `61`. */
function measuredRecall(): string {
  const snapshot = read('docs/superpowers/recall-lite.txt')
  const match = /overall candidate recall: \d+\/\d+ = (\d+)%/.exec(snapshot)
  if (match === null) throw new Error('recall-lite.txt carries no measurement line')
  return match[1] as string
}

describe('documentation matches the artifacts', () => {
  it('README quotes the recall its snapshot measured', () => {
    const measured = measuredRecall()
    for (const file of ['README.md', 'README.zh-CN.md']) {
      const text = read(file)
      const claimed = /(?:candidate recall|候选召回率) \*\*(\d+)%\*\*/.exec(text)
      expect(claimed, `${file} states no recall figure`).not.toBeNull()
      expect(claimed?.[1], `${file} disagrees with recall-lite.txt`).toBe(measured)
    }
  })

  it('README quotes the gold repository count that eval/gold holds', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const gold = readdirSync(path.join(ROOT, 'eval/gold')).filter((name) => name.endsWith('.json')).length
    expect(read('README.md')).toContain(`${gold} gold repositories`)
    expect(read('README.zh-CN.md')).toContain(`${gold} 个 gold 仓库`)
  })

  it('the typecheck claim names as many configs as the script runs', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    const typecheck = scripts['typecheck'] ?? ''
    // Count `tsc` invocations: `tsc --noEmit && tsc -p a.json && tsc -p b.json`.
    const configs = (typecheck.match(/\btsc\b/g) ?? []).length
    expect(configs).toBe(3)
    // And no document may still claim two.
    for (const file of ['README.md', 'README.zh-CN.md', 'docs/superpowers/EVIDENCE.md']) {
      expect(read(file), `${file} still claims two configs`).not.toMatch(/two tsconfigs|两套配置/)
    }
  })

  it('the version in package.json is the one the release note states', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    // The README's release block starts with the version in backticks.
    expect(read('README.md')).toContain(`\`${version}\``)
  })
})
