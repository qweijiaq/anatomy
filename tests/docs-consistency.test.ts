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

describe('the README command list matches the CLI', () => {
  /**
   * The README's command block is the first thing a reader copies from, and it is
   * hand-maintained. A command added to the CLI and not to the list is invisible; a
   * command listed and not dispatched sends the reader to an error message.
   *
   * Extracted from the fenced `bash` block, so prose mentioning a command does not
   * count as documenting it.
   */
  function readmeCommands(): Set<string> {
    const names = new Set<string>()
    for (const file of ['README.md']) {
      const text = read(file)
      // All fenced blocks: the command list is split across two of them (those that
      // need source, those that do not), so reading only the first finds none.
      for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
        for (const match of (block[1] as string).matchAll(/^ana ([a-z][a-z-]*)/gm)) {
          names.add(match[1] as string)
        }
      }
    }
    return names
  }

  /** The command names the CLI's own usage text advertises. */
  function cliCommands(): Set<string> {
    const usage = /const USAGE = `Usage: ana <command> \[options\]([\s\S]*?)`/.exec(read('src/cli.ts'))?.[1] ?? ''
    const names = new Set<string>()
    for (const match of usage.matchAll(/^ {2}([a-z][a-z-]*)(?: |$)/gm)) names.add(match[1] as string)
    return names
  }

  it('documents every command the CLI advertises', () => {
    const documented = readmeCommands()
    for (const command of cliCommands()) {
      expect(documented, `README does not list \`ana ${command}\``).toContain(command)
    }
  })

  it('lists no command the CLI does not advertise', () => {
    const advertised = cliCommands()
    for (const command of readmeCommands()) {
      expect(advertised, `README lists \`ana ${command}\` but the CLI does not`).toContain(command)
    }
  })
})

describe('no test file is silently empty', () => {
  /**
   * A test file with no `it()` passes, and the suite count drops without anything
   * complaining — the same shape as a gate whose assertion was deleted. This is
   * cheap and it only fires when a file was emptied rather than trimmed.
   */
  it('every test file asserts something', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const files = readdirSync(path.join(ROOT, 'tests'))
      .filter((name) => name.endsWith('.test.ts'))
      .sort()
    expect(files.length).toBeGreaterThan(30)
    for (const name of files) {
      const text = readFileSync(path.join(ROOT, 'tests', name), 'utf8')
      expect(/(^|\s)(it|test)\(/.test(text), `tests/${name} contains no test`).toBe(true)
    }
  })
})
