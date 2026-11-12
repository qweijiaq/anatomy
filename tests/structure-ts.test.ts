import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { Scope, StructureIndex } from '../src/contracts/types.js'
import { selectScope } from '../src/kernel/scope.js'
import { indexTypeScript, mergeIndexes } from '../src/kernel/structure/index.js'

// --- fixtures -------------------------------------------------------------

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function repoOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'anatomy-structure-'))
  created.push(root)
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return root
}

/** What the kernel does: scope the tree, then index what the scope kept. */
async function indexOf(files: Record<string, string>): Promise<StructureIndex> {
  const root = await repoOf(files)
  const scope: Scope = await selectScope(root)
  return indexTypeScript(root, scope)
}

/**
 * One repository that exercises every resolution path at once: a relative chain,
 * an ESM `.js` specifier with only a `.ts` twin, a directory `index.ts`, a
 * package specifier, an absolute specifier, and a relative import that names
 * nothing on disk.
 */
const resolutionFiles = (): Record<string, string> => ({
  'src/a.ts': [
    "import { helper } from './b'",
    "import type { Twin } from './c.js'",
    "import { z } from 'zod'",
    "import fs from 'node:fs'",
    "import '/opt/absolute.js'",
    "import { gone } from './missing'",
    '',
    'export const a = helper(z, fs, gone)',
    'export type Uses = Twin',
    '',
  ].join('\n'),
  'src/b.ts': [
    'export function helper(...args: unknown[]): unknown {',
    '  function nested(): void {}',
    '  nested()',
    '  return args[0]',
    '}',
    '',
  ].join('\n'),
  'src/c.ts': 'export type Twin = string\n',
  'src/dir/index.ts': 'export const fromDir = 1\n',
  'src/uses-dir.ts': "import { fromDir } from './dir'\nexport const uses = fromDir\n",
  'README.md': '# widget\n',
  'src/ignored.py': 'x = 1\n',
})

const symbolFiles = (): Record<string, string> => ({
  'src/symbols.ts': [
    'export function topFn(): void {}',
    'export class Widget {',
    '  method(): void {}',
    '}',
    'export interface Shape {',
    '  area(): number',
    '}',
    "export type Alias = string",
    'export enum Color {',
    '  Red,',
    '}',
    'export const constant = 1',
    'export let mutable = 2',
    'export var legacy = 3',
    'const notExported = 4',
    'export const { alpha, beta } = { alpha: 1, beta: 2 }',
    'declare namespace NS {',
    '  function innerFn(): void',
    '  const innerTyped: number',
    '  const innerInit = 5',
    '}',
    'function privateHelper(): void {',
    '  function nested(): void {}',
    '  nested()',
    '}',
    '',
  ].join('\n'),
})

const moduleAt = (index: StructureIndex, target: string) => {
  const found = index.modules.find((module) => module.path === target)
  if (found === undefined) throw new Error(`no module for ${target}`)
  return found
}

// --- tests ----------------------------------------------------------------

describe('indexTypeScript', () => {
  it('resolves relative specifiers and leaves packages unresolved', async () => {
    const index = await indexOf(resolutionFiles())
    const a = moduleAt(index, 'src/a.ts')

    // A relative chain: `./b` is a file, `./c.js` is the ESM spelling of `c.ts`.
    expect(a.imports).toContainEqual({ from: 'src/a.ts', specifier: './b', resolved: 'src/b.ts' })
    expect(a.imports).toContainEqual({ from: 'src/a.ts', specifier: './c.js', resolved: 'src/c.ts' })
    // A package and an absolute path are outside the analysed tree by design:
    // no edge, and — critically — not counted as a broken relative import.
    expect(a.imports).toContainEqual({ from: 'src/a.ts', specifier: 'zod', resolved: null })
    expect(a.imports).toContainEqual({ from: 'src/a.ts', specifier: 'node:fs', resolved: null })
    expect(a.imports).toContainEqual({
      from: 'src/a.ts',
      specifier: '/opt/absolute.js',
      resolved: null,
    })
    // A relative import naming nothing on disk is the only unresolved edge here.
    expect(a.imports).toContainEqual({ from: 'src/a.ts', specifier: './missing', resolved: null })
    expect(index.unresolved).toBe(1)
  })

  it('resolves a directory specifier to its index file', async () => {
    const index = await indexOf(resolutionFiles())

    expect(moduleAt(index, 'src/uses-dir.ts').imports).toContainEqual({
      from: 'src/uses-dir.ts',
      specifier: './dir',
      resolved: 'src/dir/index.ts',
    })
    expect(moduleAt(index, 'src/dir/index.ts').path).toBe('src/dir/index.ts')
  })

  it('indexes only the files the scope kept', async () => {
    const index = await indexOf(resolutionFiles())
    const paths = index.modules.map((module) => module.path)

    expect(paths).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/dir/index.ts',
      'src/uses-dir.ts',
    ])
    expect(paths).not.toContain('README.md')
    expect(paths).not.toContain('src/ignored.py')
  })

  it('records every top-level declaration kind with a 1-based line', async () => {
    const index = await indexOf(symbolFiles())
    const symbols = index.symbols.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}`)

    expect(symbols).toEqual([
      'topFn:function:1',
      'Widget:class:2',
      // Class members are not symbols: the class itself is the unit of design.
      'Shape:interface:5',
      'Alias:type:8',
      // The contract has no `enum` kind; an enum is a type-level declaration.
      'Color:type:9',
      'constant:const:12',
      'mutable:const:13',
      'legacy:const:14',
      'notExported:const:15',
      // Destructured bindings are separate top-level names.
      'alpha:const:16',
      'beta:const:16',
      // Ambient namespace members are exported implicitly; no initializer is
      // needed for a declaration, so `innerTyped` is not a value binding.
      'innerFn:function:18',
      'innerInit:const:20',
      'privateHelper:function:22',
    ])
    expect(index.symbols.every((symbol) => symbol.path === 'src/symbols.ts')).toBe(true)
  })

  it('keeps importing files that still parse and notes parse errors once', async () => {
    const index = await indexOf({
      'src/b.ts': 'export function helper(): number {\n  return 1\n}\n',
      'src/broken.ts': "import { helper } from './b'\nexport function oops( {\nconst y =\n",
      'src/ok.ts': 'export const ok = 1\n',
    })

    // The recovery matters more than the error: the recovered import edge is what
    // a later stage uses to see the boundary.
    expect(moduleAt(index, 'src/broken.ts').imports).toContainEqual({
      from: 'src/broken.ts',
      specifier: './b',
      resolved: 'src/b.ts',
    })
    expect(index.notes).toEqual(['parse errors in 1 files'])
  })

  it('indexes an empty scope without inventing a caveat', async () => {
    const index = await indexOf({ 'README.md': '# empty\n' })

    expect(index).toEqual({ modules: [], symbols: [], unresolved: 0, notes: [] })
  })
})

describe('mergeIndexes', () => {
  const indexOfOne = (target: string, unresolved: number, notes: string[]): StructureIndex => ({
    modules: [{ path: target, imports: [] }],
    symbols: [{ name: 'x', kind: 'const', path: target, line: 1 }],
    unresolved,
    notes,
  })

  it('concatenates, dedupes and sums', () => {
    const merged = mergeIndexes([
      indexOfOne('a.ts', 1, ['first']),
      indexOfOne('b.ts', 2, ['first', 'second']),
    ])

    expect(merged.modules.map((module) => module.path)).toEqual(['a.ts', 'b.ts'])
    expect(merged.symbols).toHaveLength(2)
    expect(merged.unresolved).toBe(3)
    expect(merged.notes).toEqual(['first', 'second'])

    // Same module and same `path:name` symbol twice: counted once, but the
    // unresolved tally is a measurement, not an identity, so it still sums.
    const repeated = mergeIndexes([indexOfOne('a.ts', 1, []), indexOfOne('a.ts', 1, [])])
    expect(repeated.modules).toHaveLength(1)
    expect(repeated.symbols).toHaveLength(1)
    expect(repeated.unresolved).toBe(2)
  })
})
