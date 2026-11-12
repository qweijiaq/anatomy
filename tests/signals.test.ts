import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import type { CanonicalFile, StructureIndex } from '../src/contracts/types.js'
import { canonicalizeFile, canonicalizeText } from '../src/kernel/canonicalize.js'
import { selectScope } from '../src/kernel/scope.js'
import { collectSignals, scoreFile, SIGNAL_WEIGHTS } from '../src/kernel/signals.js'
import { indexTypeScript } from '../src/kernel/structure/index.js'

// --- fixtures -------------------------------------------------------------

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/signals-repo/', import.meta.url)).replace(
  /\/$/,
  '',
)

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function repoOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'anatomy-signals-'))
  created.push(root)
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return root
}

/** A `CanonicalFile` built the way the kernel builds one, from already-canonical text. */
function fileOf(text: string, filePath = 'src/a.ts'): CanonicalFile {
  const canonical = canonicalizeText(text)
  return {
    path: filePath,
    text: canonical.text,
    lineCount: canonical.lineCount,
    encoding: 'utf8',
    hadBom: false,
  }
}

const emptyIndex = (): StructureIndex => ({ modules: [], symbols: [], unresolved: 0, notes: [] })

const kindsOf = (candidates: ReturnType<typeof scoreFile>): string[] =>
  candidates.map((candidate) => candidate.kind)

/** A function whose body is `bodyLines` statements long. */
function longFunction(bodyLines: number): string {
  const lines = ['export function big(): number {', '  let total = 0']
  for (let i = 0; i < bodyLines; i += 1) lines.push(`  total += ${i}`)
  lines.push('  return total', '}', '')
  return lines.join('\n')
}

/** `depth` nested `if`s inside one function. */
function nestedFunction(depth: number): string {
  const lines = ['export function deep(a: number): number {']
  for (let i = 0; i < depth; i += 1) lines.push(`${'  '.repeat(i + 1)}if (a > ${i}) {`)
  lines.push(`${'  '.repeat(depth + 1)}return a`)
  for (let i = depth - 1; i >= 0; i -= 1) lines.push(`${'  '.repeat(i + 1)}}`)
  lines.push('}', '')
  return lines.join('\n')
}

/**
 * The same shape without semicolons, so every `if` header also carries the
 * statement written above it.
 */
function semicolonFreeNested(depth: number): string {
  const lines = ['export function deep(a: number): number {']
  for (let i = 0; i < depth; i += 1) {
    const pad = '  '.repeat(i + 1)
    lines.push(`${pad}const x${i} = a + ${i}`)
    lines.push(`${pad}if (x${i} > ${i}) {`)
  }
  lines.push(`${'  '.repeat(depth + 1)}return a`)
  for (let i = depth - 1; i >= 0; i -= 1) lines.push(`${'  '.repeat(i + 1)}}`)
  lines.push('}', '')
  return lines.join('\n')
}

// --- weights --------------------------------------------------------------

describe('SIGNAL_WEIGHTS', () => {
  it('weights every kind exactly as the brief fixes it', () => {
    expect(SIGNAL_WEIGHTS).toEqual({
      'custom-infra': 3,
      'decision-trace': 3,
      complexity: 2,
      abstraction: 2,
      evolution: 1,
      'test-spec': 1,
    })
  })
})

// --- decision-trace -------------------------------------------------------

describe('decision-trace', () => {
  it('records a tradeoff comment at the comment line', () => {
    const candidates = scoreFile(
      fileOf('// we chose a ring buffer instead of a queue\nconst q = []\n'),
      emptyIndex(),
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      path: 'src/a.ts',
      kind: 'decision-trace',
      line: 1,
      score: 3,
    })
    expect(candidates[0]!.matched).toContain('decision-trace:we chose')
    expect(candidates[0]!.matched).toContain('decision-trace:instead of')
  })

  it('points at the first line of a block comment', () => {
    const text = ['export const a = 1', '', '/*', ' * tradeoff: memory against speed', ' */', 'export const b = 2', ''].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'decision-trace', line: 3 })
    expect(candidates[0]!.matched).toEqual(['decision-trace:tradeoff'])
  })

  it('understands the Chinese equivalents', () => {
    const candidates = scoreFile(
      fileOf('// 这里刻意不做缓存，因为读写比例是 100:1\nconst cache = new Map()\n'),
      emptyIndex(),
    )
    expect(candidates[0]!.matched).toContain('decision-trace:刻意')
    expect(candidates[0]!.matched).toContain('decision-trace:因为')
  })

  it('reads string text too, because a reason is often a message', () => {
    const candidates = scoreFile(
      fileOf('export const reason = "workaround for the device driver"\n'),
      emptyIndex(),
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'decision-trace', line: 1 })
    expect(candidates[0]!.matched).toEqual(['decision-trace:workaround'])
  })

  it('does not read identifiers, only comments and strings', () => {
    expect(scoreFile(fileOf('export function becauseOfThis(): void {}\n'), emptyIndex())).toEqual([])
  })

  it('scores nothing at all for a file that announces itself as generated', () => {
    const text = [
      '// @generated by protoc-gen-ts. DO NOT EDIT.',
      '// we chose this instead of a builder because the schema owns it',
      'export class Dispatcher {',
      '  run(): void {}',
      '}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('does not read the body of a generated file', () => {
    const lines = ['// This file is generated by prisma-client-js. Do not modify it by hand.']
    lines.push('export interface CacheEntryRow {', '  value: string', '}')
    lines.push('export class SchedulerPool {')
    lines.push('  run(): void {', '    const scratch = new Uint8Array(64)', '  }')
    lines.push('}')
    for (let i = 0; i < 70; i += 1) lines.push(`export const row${i} = ${i}`)
    expect(scoreFile(fileOf(lines.join('\n'), 'src/generated/client.ts'), emptyIndex())).toEqual([])
  })

  it('does not silence a file that asks the reader not to edit a list', () => {
    const text = [
      '// Do not edit this list; it is sorted',
      'export class Scheduler {',
      '  run(): void {}',
      '}',
      '',
    ].join('\n')
    expect(kindsOf(scoreFile(fileOf(text), emptyIndex()))).toEqual(['custom-infra'])
  })

  it('does not silence a file whose prose says it was generated by hand', () => {
    const text = [
      '// generated by hand from the spec',
      '// we chose a queue instead of a stack',
      'export const order = 1',
      '',
    ].join('\n')
    expect(kindsOf(scoreFile(fileOf(text), emptyIndex()))).toEqual(['decision-trace'])
  })

  it('silences a file whose banner is a bare generated marker', () => {
    const text = [
      '// @generated',
      'export class Scheduler {',
      '  run(): void {}',
      '}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('still reads a file whose banner only says who wrote it', () => {
    const text = ['// Copyright 2024 the anatomy authors.', '// we chose a queue instead of a stack'].join('\n')
    expect(kindsOf(scoreFile(fileOf(text), emptyIndex()))).toEqual(['decision-trace'])
  })
})

// --- custom-infra ---------------------------------------------------------

describe('custom-infra', () => {
  it('fires on a hand-written wheel', () => {
    expect(kindsOf(scoreFile(fileOf('class Scheduler {'), emptyIndex()))).toEqual(['custom-infra'])
  })

  it('does not fire when the file only calls a library', () => {
    const call = [
      "import { LRUCache } from 'lru-cache'",
      'const cache = new LRUCache({ max: 8 })',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(call), emptyIndex())).toEqual([])
  })

  it('does not fire on a name the file imported', () => {
    const borrowed = [
      "import { LRUCache } from 'lru-cache'",
      'export class LRUCache {',
      '  get(): void {}',
      '}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(borrowed), emptyIndex())).toEqual([])
  })

  it('separates a value binding from an implementation', () => {
    const text = [
      'const queue: Job[] = []',
      'const pool = new Map<string, Job>()',
      'const cache = { get() {} }',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.matched).toEqual(['custom-infra:cache'])
  })

  it('does not treat a type-only declaration as custom infrastructure', () => {
    const text = [
      'export type QueueOptions = { size: number }',
      'export interface CacheEntry { value: string }',
      'export namespace Cache {',
      '  export const version = 1',
      '}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text, 'src/cache/types.ts'), emptyIndex())).toEqual([])
  })

  it('skips a declaration file, which has no behaviour to read', () => {
    const text = [
      'export interface CacheEntry { value: string }',
      'export declare class SchedulerPool { run(): void }',
      'export declare const queue: unknown[]',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text, 'src/cache/index.d.ts'), emptyIndex())).toEqual([])
  })

  it('recognises the wheels this product exists for', () => {
    const names = [
      'RingBuffer',
      'withBackoff',
      'Debouncer',
      'RateLimiter',
      'Semaphore',
      'Trie',
      'Heap',
      'EventEmitter',
    ]
    for (const name of names) {
      const candidates = scoreFile(fileOf(`export class ${name} {\n  run(): void {}\n}\n`), emptyIndex())
      expect(kindsOf(candidates), name).toEqual(['custom-infra'])
      expect(candidates[0]!.score, name).toBe(3)
    }
  })

  it('does not fire on a keyword buried in an ordinary word', () => {
    const text = [
      'const asString = (value: unknown): string => String(value)',
      'class Spring {}',
      'const busy = { idle: true, pending: 0 }',
      'export const buses: string[] = []',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('keeps a keyword at the head of a longer word', () => {
    for (const name of ['RingBuffer', 'Debouncer', 'Serializer']) {
      const candidates = scoreFile(fileOf(`export class ${name} {\n  run(): void {}\n}\n`), emptyIndex())
      expect(kindsOf(candidates), name).toEqual(['custom-infra'])
      expect(candidates[0]!.score, name).toBe(3)
    }
  })

  it('recognises a scheduler written as an object or a function', () => {
    const text = [
      'export const dispatcher = {',
      '  send(): void {},',
      '}',
      'export function createSerializer(): void {}',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates.map((candidate) => candidate.matched)).toEqual([
      ['custom-infra:dispatcher'],
      ['custom-infra:serializer'],
    ])
  })
})

// --- complexity -----------------------------------------------------------

describe('complexity', () => {
  it('fires on a long function', () => {
    const candidates = scoreFile(fileOf(longFunction(61)), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'complexity', line: 1, score: 2 })
    expect(candidates[0]!.matched).toEqual(['complexity:long-function'])
  })

  it('leaves an ordinary function alone', () => {
    expect(scoreFile(fileOf(longFunction(40)), emptyIndex())).toEqual([])
  })

  it('fires on deep nesting and leaves four levels alone', () => {
    expect(scoreFile(fileOf(nestedFunction(4)), emptyIndex())).toEqual([])
    const candidates = scoreFile(fileOf(nestedFunction(5)), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.matched).toEqual(['complexity:deep-nesting'])
  })

  it('fires on a lock, an atomic or a manual buffer', () => {
    const lock = ['export function guard(): void {', '  const lock = new Mutex()', '}', ''].join('\n')
    expect(scoreFile(fileOf(lock), emptyIndex())[0]!.matched).toEqual(['complexity:Mutex'])

    const buffer = ['export function copy(size: number): Uint8Array {', '  return new Uint8Array(size)', '}', ''].join('\n')
    expect(scoreFile(fileOf(buffer), emptyIndex())[0]!.matched).toEqual(['complexity:buffer'])

    const plain = ['export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n')
    expect(scoreFile(fileOf(plain), emptyIndex())).toEqual([])
  })

  it('measures a Python function body by indentation', () => {
    const lines = ['def handler(event):']
    for (let i = 0; i < 62; i += 1) lines.push(`    step_${i}(event)`)
    lines.push('')
    const candidates = scoreFile(fileOf(lines.join('\n'), 'src/handler.py'), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'complexity', line: 1, score: 2 })
    expect(candidates[0]!.matched).toEqual(['complexity:long-function'])
  })

  it('does not read a regular expression body as code', () => {
    expect(scoreFile(fileOf("const reason = /unsafe entry: \\/tmp\\/x/\n"), emptyIndex())).toEqual([])
  })

  it('counts nesting in semicolon-free code as deep as in semicolon style', () => {
    expect(scoreFile(fileOf(semicolonFreeNested(4)), emptyIndex())).toEqual([])
    const candidates = scoreFile(fileOf(semicolonFreeNested(5)), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.matched).toEqual(['complexity:deep-nesting'])
  })

  it('does not read an object literal as a block', () => {
    const text = [
      'const config = {',
      '  retry: { count: 3, backoff: { base: 10, jitter: { max: 4 } } },',
      '  done: true,',
      '}',
      'export const ready = true',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('does not count a block-bodied callback as a nesting level', () => {
    const lines = ['export function walk(groups: string[][]): void {']
    for (let i = 0; i < 5; i += 1) {
      lines.push(`${'  '.repeat(i + 1)}groups.forEach((group${i}) => {`)
    }
    lines.push(`${'  '.repeat(6)}handle(group4)`)
    for (let i = 4; i >= 0; i -= 1) lines.push(`${'  '.repeat(i + 1)}})`)
    lines.push('}', '')
    expect(scoreFile(fileOf(lines.join('\n')), emptyIndex())).toEqual([])
  })

  it('still counts control flow inside a callback body', () => {
    const lines = ['export function walk(groups: string[][]): void {', '  groups.forEach((group) => {']
    for (let i = 0; i < 5; i += 1) lines.push(`${'  '.repeat(i + 2)}if (group.length > ${i}) {`)
    lines.push(`${'  '.repeat(7)}handle(group)`)
    for (let i = 4; i >= 0; i -= 1) lines.push(`${'  '.repeat(i + 2)}}`)
    lines.push('  })', '}', '')
    const candidates = scoreFile(fileOf(lines.join('\n')), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.matched).toEqual(['complexity:deep-nesting'])
  })

  it('counts no nesting for object literals and callbacks', () => {
    const text = [
      'export function rowsOf(cells: string[][]): string[][] {',
      '  return cells.map((row) =>',
      '    row.map((cell) =>',
      "      cell.split(',').map((part) =>",
      "        part.split('').map((char) =>",
      '          ({',
      '            value: char,',
      '            width: { outer: { inner: { deepest: { bottom: { tip: char } } } } },',
      '          }),',
      '        ),',
      '      ),',
      '    ),',
      '  )',
      '}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('does not score a callback passed as an argument', () => {
    const lines = ["describe('suite', () => {"]
    for (let i = 0; i < 61; i += 1) lines.push(`  expect(value).toBe(${i})`)
    lines.push('})', '')
    expect(scoreFile(fileOf(lines.join('\n')), emptyIndex())).toEqual([])
  })
})

// --- abstraction ----------------------------------------------------------

describe('abstraction', () => {
  it('fires when interfaces outnumber concrete classes', () => {
    const text = [
      'export interface A { a: string }',
      'export interface B { b: number }',
      'export class Impl implements A, B {',
      '  a = ""',
      '  b = 0',
      '}',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.matched).toEqual(['abstraction:interfaces-outnumber-classes'])
  })

  it('stays quiet on the lone deps interface of a module', () => {
    const text = [
      'export interface Deps { now: () => Date }',
      'export function create(deps: Deps): string {',
      '  return deps.now().toISOString()',
      '}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('stays quiet when implementations dominate', () => {
    const text = [
      'export interface A { a: string }',
      'export class One implements A { a = "" }',
      'export class Two {}',
      '',
    ].join('\n')
    expect(scoreFile(fileOf(text), emptyIndex())).toEqual([])
  })

  it('fires on a leaf module that three modules import', async () => {
    const root = await repoOf({
      'src/core.ts': 'export const CORE = 1\n',
      'src/a.ts': "import { CORE } from './core.js'\nexport const A = CORE\n",
      'src/b.ts': "import { CORE } from './core.js'\nexport const B = CORE\n",
      'src/c.ts': "import { CORE } from './core.js'\nexport const C = CORE\n",
    })
    const scope = await selectScope(root)
    const structure = await indexTypeScript(root, scope)
    const core = await canonicalizeFile(path.join(root, 'src/core.ts'))

    const candidates = scoreFile(core, structure)
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['abstraction'])
    expect(candidates[0]!.matched).toEqual(['abstraction:imported-by-3-importing-nothing'])
  })

  it('does not fire on a hub that imports something itself', async () => {
    const root = await repoOf({
      'src/core.ts': "import { helper } from './a.js'\nexport const CORE = helper\n",
      'src/a.ts': "import { CORE } from './core.js'\nexport const A = CORE\n",
      'src/b.ts': "import { CORE } from './core.js'\nexport const B = CORE\n",
      'src/c.ts': "import { CORE } from './core.js'\nexport const C = CORE\n",
    })
    const scope = await selectScope(root)
    const structure = await indexTypeScript(root, scope)
    const core = await canonicalizeFile(path.join(root, 'src/core.ts'))
    expect(scoreFile(core, structure)).toEqual([])
  })
})

// --- evolution ------------------------------------------------------------

describe('evolution', () => {
  it('reads evolution vocabulary from comments and identifiers', () => {
    const text = [
      '// removed with the 0.8 config loader; kept as a shim',
      'export const migrateV1 = 1',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'evolution', line: 1, score: 1 })
    expect(candidates[0]!.matched).toEqual(['evolution:removed', 'evolution:migrate'])
  })
})

// --- test-spec ------------------------------------------------------------

describe('custom-infra in a hand-written structure', () => {
  it('scores the methods, not only the class that holds them', () => {
    // The decisions a reader learns from live in the methods: a class scores once
    // at its declaration, and `#moveToRecent`/`evict`/`resize` used to be invisible.
    const file = fileOf(
      [
        'export default class QuickLRU extends Map {',
        '  #moveToRecent(key, item) {',
        '    if (!this.#cache.has(key)) return',
        '  }',
        '',
        '  evict(count = 1) {',
        '    let removed = 0',
        '  }',
        '}',
      ].join('\n'),
      'src/cache.js',
    )
    // Grouping collapses a short file into one candidate on purpose; what this
    // proves is that the methods were scanned at all.
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).toContain('custom-infra:evict')
  })

  it('does not score the on* callback convention as an implementation', () => {
    const file = fileOf(
      [
        'class Store {',
        '  set(key, value) {',
        '    this.onEvict(key)',
        '  }',
        '}',
      ].join('\n'),
      'src/store.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).not.toContain('custom-infra:evict')
  })

  it('does not score methods in a test file', () => {
    // A test that builds `onEvict` callbacks a dozen times is exercising the API.
    const file = fileOf(
      ['it("works", () => {', '  const evict = () => {}', '})'].join('\n'),
      'test/cache.test.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words.some((word) => word.startsWith('custom-infra'))).toBe(false)
  })

  it('recognises a wheel at the tail of a name too', () => {
    // `enqueue`/`dequeue` never start with `queue`; matching only the head missed
    // every queue written as a verb pair.
    const file = fileOf(
      ['class Queue {', '  enqueue(value) {', '    this.#size++', '  }', '}'].join('\n'),
      'src/queue.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).toContain('custom-infra:queue')
  })
})

describe('members of a wheel class', () => {
  it('makes the ordinary-named methods of a recognised wheel candidates', () => {
    // `#moveToRecent` and `#deleteIfExpired` say nothing on their own, yet they are
    // *how* this cache works — the reason to read the file at all. A 329-line LRU
    // used to offer a single candidate, on its declaration line.
    const file = fileOf(
      [
        'export default class QuickLRU extends Map {',
        '  #moveToRecent(key, item) {',
        '    const value = item.value',
        '    if (this.#cache.has(key)) this.#cache.delete(key)',
        '    this.#cache.set(key, item)',
        '  }',
        '',
        '  #deleteIfExpired(key, item) {',
        '    if (this.#maxAge === undefined) return',
        '  }',
        '}',
      ].join('\n'),
      'src/cache.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).toContain('custom-infra:member')
  })

  it('leaves an ordinary class alone', () => {
    const file = fileOf(
      ['class Render {', '  #paint(node) {', '    return node', '  }', '}'].join('\n'),
      'src/render.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words.some((word) => word === 'custom-infra:member')).toBe(false)
  })

  it('caps how many members one class contributes', () => {
    const body: string[] = ['class Queue {']
    for (let i = 0; i < 20; i += 1) {
      body.push(`  #step${i}(value) {`, `    return value + ${i}`, '  }')
    }
    body.push('}')
    const candidates = scoreFile(fileOf(body.join('\n'), 'src/queue.js'), emptyIndex())
    expect(candidates.length).toBeLessThanOrEqual(11)
  })
})

describe('snapshot before dispatch', () => {
  it('scores a handler list copied before it is iterated', () => {
    // `handlers.slice().map(...)` is how a callback can unregister itself mid-emit
    // without skipping or repeating a handler.
    const file = fileOf(
      [
        'const handlers = map.get(type)',
        'if (handlers) {',
        '  handlers.slice().map((handler) => {',
        '    handler(evt)',
        '  })',
        '}',
      ].join('\n'),
      'src/emitter.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).toContain('custom-infra:snapshot-before-dispatch')
  })

  it('does not fire on an ordinary slice', () => {
    const file = fileOf(['const head = list.slice()', 'export const n = head.length'].join('\n'), 'src/a.js')
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).not.toContain('custom-infra:snapshot-before-dispatch')
  })

  it('does not read design out of comments in a test file', () => {
    // Two such comments once spent two of five candidate slots on a real repo.
    const file = fileOf(
      ['// because the emitter is synchronous, this order matters', 'it("x", () => {', '  expect(1).toBe(1)', '})'].join('\n'),
      'test/emitter.test.js',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words.some((word) => word.startsWith('decision-trace'))).toBe(false)
  })
})

describe('overload signatures and distant hits', () => {
  it('scores a two-directional API declared by overloads', () => {
    // `ms(number)` formats, `ms(string)` parses: one name, two directions. The
    // declarations carry no code, so length, nesting and imports all see nothing.
    const file = fileOf(
      [
        'export function ms(value: string, options?: Options): number;',
        'export function ms(value: number, options?: Options): string;',
        'export function ms(',
        '  value: string | number,',
        '  options?: Options,',
        ') {',
        '  return 0',
        '}',
      ].join('\n'),
      'src/index.ts',
    )
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words).toContain('abstraction:overload:ms')
  })

  it('does not score a single declaration as an overload', () => {
    const file = fileOf('export function ms(value: string): number {\n  return 0\n}\n', 'src/index.ts')
    const words = scoreFile(file, emptyIndex()).flatMap((candidate) => candidate.matched)
    expect(words.some((word) => word.startsWith('abstraction:overload'))).toBe(false)
  })

  it('keeps two distant hits in one kind as separate candidates', () => {
    // Merging a hit far below into the first hit's candidate points the reader at
    // the wrong code, and the distant decision then has no candidate at all.
    const lines = ['// we chose a queue instead of a stack', 'export const a = 1']
    for (let i = 0; i < 60; i += 1) lines.push(`export const pad${i} = ${i}`)
    lines.push('// because memory is cheaper than latency here', 'export const b = 2')
    const candidates = scoreFile(fileOf(lines.join('\n'), 'src/a.ts'), emptyIndex())
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(new Set(candidates.map((candidate) => candidate.line)).size).toBe(candidates.length)
  })
})

describe('test-spec chained calls', () => {
  it('counts the assertions of an it.each table', () => {
    // Vitest's table form opens two argument lists; only the second holds the
    // callback, and a version that looked at the first lost the whole block.
    const file = fileOf([
      "it.each([[1, 2], [3, 4]])('adds', (a, b) => {",
      '  expect(a + b).toBe(3)',
      '  expect(a).toBeLessThan(b)',
      '  expect(b).toBeGreaterThan(a)',
      '  expect(a * b).toBeGreaterThan(0)',
      '})',
    ].join('\n'), 'src/a.test.ts')
    expect(scoreFile(file, emptyIndex())).toContainEqual(
      expect.objectContaining({ kind: 'test-spec' }),
    )
  })
})

describe('test-spec', () => {
  const denseTest = (assertions: number): string => {
    const lines = [
      "import { it, expect } from 'vitest'",
      "it('rejects an empty list', () => {",
      '  const rows: string[] = []',
    ]
    for (let i = 0; i < assertions; i += 1) lines.push(`  expect(rows[${i}]).toBeUndefined()`)
    lines.push('})', '')
    return lines.join('\n')
  }

  it('fires on a test that pins four behaviours', () => {
    const candidates = scoreFile(fileOf(denseTest(4), 'tests/rows.test.ts'), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ kind: 'test-spec', line: 2, score: 1 })
    expect(candidates[0]!.matched).toEqual(['test-spec:assertion-density'])
  })

  it('leaves a sparse test alone', () => {
    expect(scoreFile(fileOf(denseTest(3), 'tests/rows.test.ts'), emptyIndex())).toEqual([])
  })

  it('never fires outside a test file', () => {
    expect(scoreFile(fileOf(denseTest(6), 'src/rows.ts'), emptyIndex())).toEqual([])
  })

  it('counts Python asserts per test function', () => {
    const text = [
      'def parse(text):',
      '    return text.strip() or None',
      '',
      '',
      'def test_parse_rejects_empty():',
      "    assert parse('') is None",
      "    assert parse(' ') is None",
      "    assert parse('\\t') is None",
      "    assert parse('\\n') is None",
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text, 'tests/test_parse.py'), emptyIndex())
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['test-spec'])
    expect(candidates[0]!.line).toBe(5)
  })

  it('does not let a callback-less call absorb the test below it', () => {
    const text = [
      "import { it, expect } from 'vitest'",
      "it.todo('rejects an empty list')",
      "it('rejects a missing list', () => {",
      '  expect(a).toBe(1)',
      '  expect(b).toBe(2)',
      '  expect(c).toBe(3)',
      '  expect(d).toBe(4)',
      '})',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text, 'tests/rows.test.ts'), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.line).toBe(3)
    expect(candidates[0]!.matched).toEqual(['test-spec:assertion-density'])
  })

  it('does not let a callback-less call borrow its suite assertions', () => {
    const text = [
      "import { describe, it, expect } from 'vitest'",
      "describe('rows', () => {",
      "  it.todo('rejects an empty list')",
      "  it('rejects a missing list', () => {",
      '    expect(a).toBe(1)',
      '    expect(b).toBe(2)',
      '    expect(c).toBe(3)',
      '    expect(d).toBe(4)',
      '  })',
      '})',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text, 'tests/rows.test.ts'), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.line).toBe(4)
  })

  it('counts a fixture-heavy test without many assertions', () => {
    const text = [
      "import { it, expect } from 'vitest'",
      "it('replays a recorded session', async () => {",
      "  const root = await mkdtemp(path.join(tmpdir(), 'replay-'))",
      '  const fixture = await seedFixture(root)',
      '  await beforeEachHook(fixture)',
      '  expect(await replay(root)).toBe(fixture.expected)',
      '})',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text, 'tests/replay.test.ts'), emptyIndex())
    expect(candidates.map((candidate) => candidate.matched)).toEqual([['test-spec:fixture-heavy']])
  })
})

// --- merging --------------------------------------------------------------

describe('merging', () => {
  it('collapses repeated hits inside one function into one candidate', () => {
    const text = [
      'export function alpha(): void {',
      '  // we chose a instead of b',
      '  // deliberately, because of the driver',
      '}',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ line: 2, kind: 'decision-trace', score: 3 })
    expect(candidates[0]!.matched).toHaveLength(4)
    expect(new Set(candidates[0]!.matched).size).toBe(4)
  })

  it('keeps two functions apart', () => {
    const text = [
      'export function alpha(): void {',
      '  // we chose a instead of b',
      '}',
      '',
      'export function beta(): void {',
      '  // workaround for the flaky driver',
      '}',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(2)
    expect(candidates.map((candidate) => candidate.line)).toEqual([2, 6])
    expect(candidates.map((candidate) => candidate.score)).toEqual([3, 3])
  })

  it('sums the weights of different kinds in one function', () => {
    const text = [
      'export function guard(text: string): number {',
      '  // we chose a spin lock instead of a mutex because the critical section is tiny',
      '  const buf = new Uint8Array(64)',
      '  return buf.length + text.length',
      '}',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ line: 2, kind: 'decision-trace', score: 5 })
  })

  it('yields one candidate per hot spot in a long class', () => {
    const lines = ['export class WorkerPool {']
    const spots: number[] = []

    spots.push(lines.length + 1)
    lines.push('  first(a: number): number {')
    for (let i = 0; i < 5; i += 1) lines.push(`${'  '.repeat(i + 2)}if (a > ${i}) {`)
    lines.push(`${'  '.repeat(7)}return a`)
    for (let i = 4; i >= 0; i -= 1) lines.push(`${'  '.repeat(i + 2)}}`)
    lines.push('  }')

    spots.push(lines.length + 1)
    lines.push('  second(): number {')
    lines.push('    let total = 0')
    for (let i = 0; i < 400; i += 1) lines.push(`    total += ${i}`)
    lines.push('    return total')
    lines.push('  }')

    spots.push(lines.length + 1)
    lines.push('  third(): Uint8Array {')
    lines.push('    // we chose a rolling buffer instead of a copy because the pool is large')
    lines.push('    return new Uint8Array(64)')
    lines.push('  }')

    lines.push('}')

    const candidates = scoreFile(fileOf(lines.join('\n')), emptyIndex())
    expect(candidates).toHaveLength(3)
    expect(candidates.map((candidate) => candidate.line)).toEqual(spots)
    expect(candidates.every((candidate) => candidate.line !== 1)).toBe(true)
    expect(kindsOf(candidates)).toEqual(['custom-infra', 'complexity', 'decision-trace'])
  })

  it('splits a module-level run of hits that spans hundreds of lines', () => {
    const lines: string[] = []
    for (let i = 1; i <= 300; i += 1) {
      lines.push(
        i === 1 || i === 120 || i === 260
          ? `// we chose step ${i} instead of a loop because it is clearer`
          : `const step${i} = ${i}`,
      )
    }
    const candidates = scoreFile(fileOf(lines.join('\n')), emptyIndex())
    expect(candidates.map((candidate) => candidate.line)).toEqual([1, 120, 260])
  })

  it('collapses module-level hits into one candidate per file', () => {
    const text = ['// we chose a', 'export const a = 1', '// workaround b', 'export const b = 2', ''].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ line: 1, kind: 'decision-trace', score: 3 })
  })
})

// --- inputs that are not analysable --------------------------------------

describe('files with nothing to analyse', () => {
  it('skips a language the kernel does not read', () => {
    expect(scoreFile(fileOf('# README\n\nblah', 'README.md'), emptyIndex())).toEqual([])
  })

  it('skips an empty file', () => {
    expect(scoreFile(fileOf('', 'src/empty.ts'), emptyIndex())).toEqual([])
  })

  it('is pure: the same input scores the same twice', () => {
    const file = fileOf(nestedFunction(5))
    const structure = emptyIndex()
    const first = scoreFile(file, structure)
    const second = scoreFile(file, structure)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(structure.modules).toEqual([])
  })
})

// --- collectSignals -------------------------------------------------------

describe('collectSignals', () => {
  it('ranks the hand-written scheduler first in the fixture repository', async () => {
    const scope = await selectScope(FIXTURE_ROOT)
    const structure = await indexTypeScript(FIXTURE_ROOT, scope)
    const candidates = await collectSignals(FIXTURE_ROOT, scope, structure)

    // The intent is a ranking, not a fixed list: a class that is recognisably a
    // wheel now contributes its methods too, so the exact candidate count is a
    // detail of the current rules while the ordering is what this test is for.
    // src/tables.ts is ~300 plainly written lines: longer than the scheduler, and
    // still ranked below it.
    const top = candidates[0]!
    expect(top.path).toBe('src/scheduler.ts')
    expect(top.score).toBeGreaterThanOrEqual(6)
    expect(top.matched).toContain('decision-trace:instead of')

    const order = candidates.map((candidate) => candidate.path)
    expect(order.indexOf('src/scheduler.ts')).toBeLessThan(order.indexOf('src/tables.ts'))
    expect(order.indexOf('src/tables.ts')).toBeLessThan(order.indexOf('src/legacy.ts'))
    expect(candidates.some((candidate) => candidate.path === 'README.md')).toBe(false)
    expect(candidates.some((candidate) => candidate.path.startsWith('vendor/'))).toBe(false)
    expect(candidates.some((candidate) => candidate.path.startsWith('src/generated/'))).toBe(false)
  })

  it('scores a vendored framework look-alike as nothing', async () => {
    const scope = await selectScope(FIXTURE_ROOT)
    const structure = await indexTypeScript(FIXTURE_ROOT, scope)
    const vendored = await canonicalizeFile(path.join(FIXTURE_ROOT, 'vendor/react-like.js'))
    expect(scoreFile(vendored, structure)).toEqual([])
  })

  it('scores a generated client inside the scored scope as nothing', async () => {
    const scope = await selectScope(FIXTURE_ROOT)
    const structure = await indexTypeScript(FIXTURE_ROOT, scope)
    const relative = 'src/generated/prisma-client.ts'
    expect(scope.files.some((file) => file.path === relative)).toBe(true)

    const generated = await canonicalizeFile(path.join(FIXTURE_ROOT, relative))
    expect(scoreFile(generated, structure)).toEqual([])

    // The assertion above is about the banner, not about a harmless body: the same
    // declarations without it score.
    const stripped = generated.text.split('\n').slice(1).join('\n')
    expect(scoreFile(fileOf(stripped, relative), structure).length).toBeGreaterThan(0)
  })

  it('truncates to topK after sorting by score', async () => {
    const root = await repoOf({
      'src/alpha.ts': [
        'export class Dispatcher {',
        '  // workaround: we chose a synchronous dispatch instead of a microtask',
        '  run(): void {}',
        '}',
        '',
      ].join('\n'),
      'src/beta.ts': [
        'export function scan(input: string): number {',
        '  // we chose a hand-written scan instead of a regex because of backtracking',
        '  const scratch = new Uint8Array(64)',
        '  return scratch.length + input.length',
        '}',
        '',
      ].join('\n'),
      'src/gamma.ts': ['// legacy: superseded by beta.ts', 'export const legacy = 1', ''].join('\n'),
    })
    const scope = await selectScope(root)
    const structure = await indexTypeScript(root, scope)

    const top2 = await collectSignals(root, scope, structure, { topK: 2 })
    expect(top2.map((candidate) => candidate.score)).toEqual([6, 5])
    expect(top2.map((candidate) => candidate.path)).toEqual(['src/alpha.ts', 'src/beta.ts'])

    const all = await collectSignals(root, scope, structure)
    expect(all.map((candidate) => candidate.score)).toEqual([6, 5, 1])
  })

  it('defaults to 30 candidates and keeps the deterministic order', async () => {
    const files: Record<string, string> = {}
    for (let i = 1; i <= 32; i += 1) files[`src/f${String(i).padStart(2, '0')}.ts`] = '// legacy shim\n'
    const root = await repoOf(files)
    const scope = await selectScope(root)
    const structure = await indexTypeScript(root, scope)

    const candidates = await collectSignals(root, scope, structure)
    expect(candidates).toHaveLength(30)
    expect(candidates[0]!.path).toBe('src/f01.ts')
    expect(candidates[29]!.path).toBe('src/f30.ts')
  })

  it('produces byte-identical output across runs', async () => {
    const scope = await selectScope(FIXTURE_ROOT)
    const structure = await indexTypeScript(FIXTURE_ROOT, scope)
    const first = await collectSignals(FIXTURE_ROOT, scope, structure)
    const second = await collectSignals(FIXTURE_ROOT, scope, structure)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('reads scope files through the canonicalizer, so CRLF still lands on line 1', async () => {
    const root = await repoOf({ 'src/crlf.ts': '// we chose a\r\nexport const x = 1\r\n' })
    const scope = await selectScope(root)
    const candidates = await collectSignals(root, scope, emptyIndex())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ path: 'src/crlf.ts', line: 1, kind: 'decision-trace' })
  })

  it('skips a file that vanished after the scope was taken', async () => {
    const root = await repoOf({
      'src/stays.ts': '// we chose a instead of b\n',
      'src/goes.ts': '// we chose c instead of d\n',
    })
    const scope = await selectScope(root)
    await rm(path.join(root, 'src/goes.ts'))
    const candidates = await collectSignals(root, scope, emptyIndex())
    expect(candidates.map((candidate) => candidate.path)).toEqual(['src/stays.ts'])
  })
})
