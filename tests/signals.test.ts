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

  it('ignores the words in a generated header', () => {
    const text = [
      '// @generated by protoc-gen-ts. DO NOT EDIT.',
      '// we chose this instead of a builder because the schema owns it',
      'export class Dispatcher {',
      '  run(): void {}',
      '}',
      '',
    ].join('\n')
    const candidates = scoreFile(fileOf(text), emptyIndex())
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['custom-infra'])
    expect(candidates[0]!.score).toBe(3)
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

    expect(candidates.map((candidate) => [candidate.path, candidate.score])).toEqual([
      ['src/scheduler.ts', 6],
      ['src/report.ts', 3],
      ['src/legacy.ts', 1],
    ])
    expect(candidates[0]).toMatchObject({ kind: 'custom-infra', line: 7 })
    expect(candidates[0]!.matched).toContain('decision-trace:instead of')
    expect(candidates.some((candidate) => candidate.path === 'README.md')).toBe(false)
    expect(candidates.some((candidate) => candidate.path.startsWith('vendor/'))).toBe(false)
  })

  it('scores a vendored framework look-alike as nothing', async () => {
    const scope = await selectScope(FIXTURE_ROOT)
    const structure = await indexTypeScript(FIXTURE_ROOT, scope)
    const vendored = await canonicalizeFile(path.join(FIXTURE_ROOT, 'vendor/react-like.js'))
    expect(scoreFile(vendored, structure)).toEqual([])
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
