/**
 * The product's whole claim lives in this file: a snippet the model wrote is
 * checked against the canonical text of the file on disk, and anything that
 * cannot be checked is dropped or downgraded — never trusted.
 */

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Evidence, LearningPoint, Scope } from '../src/contracts/types.js'
import { MAX_EVIDENCE_BYTES, evidenceId, validatePoints } from '../src/kernel/evidence.js'

/**
 * Counts canonicalizations. The kernel's rule is "one read per file per call",
 * so the spy delegates to the real implementation and only records.
 */
const canonicalCalls = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('../src/kernel/canonicalize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kernel/canonicalize.js')>()
  return {
    ...actual,
    canonicalizeFile: (absPath: string) => {
      canonicalCalls.paths.push(absPath)
      return actual.canonicalizeFile(absPath)
    },
  }
})

const root = mkdtempSync(path.join(tmpdir(), 'anatomy-evidence-'))
const outside = mkdtempSync(path.join(tmpdir(), 'anatomy-outside-'))

writeFileSync(
  path.join(root, 'a.ts'),
  'export const answer = 42\n' +
    'export function double(n: number) {\n' +
    '  return n * 2\n' +
    '}\n',
)
// Bytes exactly as a Windows checkout would have them.
writeFileSync(path.join(root, 'crlf.ts'), 'export const crlf = true\r\nexport const also = 1\r\n')
writeFileSync(path.join(root, 'bom.ts'), '\uFEFFexport const bom = 1\n')
writeFileSync(path.join(root, 'latin1.ts'), Buffer.from('// café\nconst montant = 1\n', 'latin1'))
// The same two-line block at lines 3-4 and again at 90-91: duplicated code is
// exactly what this product reads a repository for.
const duplicated: string[] = ['export const dup = 1', 'function a() {', '  return n * 2', '}']
while (duplicated.length < 89) duplicated.push(`const filler${duplicated.length + 1} = 1`)
duplicated.push('  return n * 2', '}')
writeFileSync(path.join(root, 'dup.ts'), `${duplicated.join('\n')}\n`)
// 1 `l1`, 2 `export function f() {`, 3 `  return 1`, 4 `}`, 5 `l5`.
writeFileSync(path.join(root, 'newline.ts'), 'l1\nexport function f() {\n  return 1\n}\nl5\n')
writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1\n')

// Symlinks that are lexically inside the root but point outside it, and one
// that points at a sibling inside it: containment must be decided on what the
// path resolves to, not on what it spells.
mkdirSync(path.join(root, 'vendor'))
symlinkSync(outside, path.join(root, 'vendor', 'link-dir'))
symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'vendor', 'link-secret.ts'))
symlinkSync(path.join(root, 'a.ts'), path.join(root, 'vendor', 'link-inside.ts'))
// Larger than the evidence read cap: its bytes must never be buffered.
writeFileSync(path.join(root, 'huge.ts'), 'const padded = 1\n'.repeat(70_000))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

beforeEach(() => {
  canonicalCalls.paths.length = 0
})

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  id: 'model-supplied-id',
  path: 'a.ts',
  startLine: 1,
  endLine: 1,
  snippet: 'export const answer = 42',
  ...over,
})

const pt = (over: Partial<LearningPoint> = {}): LearningPoint => ({
  id: 'p1',
  title: 'double() is written as an expression body',
  kind: 'algorithm',
  problem: { constraint: 'c', stakes: 's' },
  alternatives: [{ approach: 'inline', cost: 'repetition' }],
  theirs: { summary: 'a doubling helper', evidence: [ev()] },
  mechanism: 'm',
  tradeoffs: [{ cost: 'c', whenItHurts: 'w' }],
  confidence: 'high',
  unknowns: [],
  recipe: null,
  ...over,
})

/** A point whose evidence is the thing under test. */
const withEvidence = (evidence: unknown[], over: Partial<LearningPoint> = {}): LearningPoint =>
  pt({ ...over, theirs: { summary: 'a doubling helper', evidence: evidence as Evidence[] } })

const escapePath = `../${path.basename(outside)}/secret.ts`
const CRLF_SNIPPET = 'export const crlf = true'
const BOM_SNIPPET = 'export const bom = 1'

describe('validatePoints — evidence that does not hold up drops the point', () => {
  it('drops a fabricated line number instead of throwing', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 999, endLine: 999, snippet: 'const x = 1' })])],
      root,
      'run1',
    )

    expect(result.dropped).toHaveLength(1)
    expect(result.kept).toEqual([])
    expect(result.stats).toMatchObject({ droppedEvidence: 1, evidenceRate: 0, avgEvidence: 0 })
  })

  it('drops a snippet that exists but on a different line than reported', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 2, endLine: 2, snippet: '  return n * 2' })])],
      root,
      'run1',
    )

    expect(result.dropped[0]?.reason).toMatch(/not on line 2 of a\.ts/)
    expect(result.stats.droppedEvidence).toBe(1)
  })

  it('drops snippets too thin to certify a point', async () => {
    // Each of these sits on the line it is cited at, so the only thing wrong
    // with it is that one character cannot be evidence of anything.
    const thin = [
      { startLine: 3, snippet: 'n' },
      { startLine: 2, snippet: '{' },
      { startLine: 3, snippet: '   ' },
    ]

    for (const { startLine, snippet } of thin) {
      const result = await validatePoints(
        [withEvidence([ev({ startLine, endLine: startLine, snippet })])],
        root,
        'run1',
      )

      expect(result.kept).toEqual([])
      expect(result.dropped).toHaveLength(1)
      expect(result.stats.droppedEvidence).toBe(1)
    }
  })

  it('drops the off-by-one range a leading newline would suggest', async () => {
    // `'\n  return 1'` sits on lines 2-3 of newline.ts; 3-4 is the wrong range.
    const result = await validatePoints(
      [withEvidence([ev({ path: 'newline.ts', startLine: 3, endLine: 4, snippet: '\n  return 1' })])],
      root,
      'run1',
    )

    expect(result.kept).toEqual([])
    expect(result.dropped[0]?.reason).toMatch(/lines 2\.\.3/)
  })

  it('drops a snippet that is not in the file at all', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ snippet: 'export const hallucinated = 1' })])],
      root,
      'run1',
    )

    expect(result.dropped[0]?.reason).toMatch(/not/i)
    expect(result.kept).toEqual([])
  })

  it('refuses the trailing empty line a file does not have', async () => {
    // a.ts has 4 lines. Text ending in `\n` has one more addressable offset, so
    // a RangeError-based check would accept line 5; the explicit bound must not.
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 5, endLine: 5 })])],
      root,
      'run1',
    )

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toMatch(/outside 1\.\.4/)
  })

  it('drops a multi-line snippet whose reported range does not cover it', async () => {
    const snippet = 'export function double(n: number) {\n  return n * 2\n}'

    const result = await validatePoints(
      [withEvidence([ev({ startLine: 3, endLine: 4, snippet })])],
      root,
      'run1',
    )

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toMatch(/lines 2\.\.4/)
  })

  it('drops a single-line snippet that claims a multi-line range', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 1, endLine: 2 })])],
      root,
      'run1',
    )

    expect(result.dropped).toHaveLength(1)
  })

  it('drops an empty snippet', async () => {
    for (const snippet of ['', '   ']) {
      const result = await validatePoints(
        [withEvidence([ev({ snippet })])],
        root,
        'run1',
      )
      expect(result.dropped).toHaveLength(1)
    }
  })

  it('drops a path that escapes the root without reading it', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: escapePath, snippet: 'export const secret = 1' })])],
      root,
      'run1',
    )

    expect(result.dropped[0]?.reason).toMatch(/escapes/)
    expect(canonicalCalls.paths).toEqual([])
  })

  it('drops an absolute path', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: path.join(root, 'a.ts') })])],
      root,
      'run1',
    )

    expect(result.dropped[0]?.reason).toMatch(/absolute/)
    expect(canonicalCalls.paths).toEqual([])
  })

  it('drops evidence for a file that does not exist', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'src/gone.ts' })])],
      root,
      'run1',
    )

    expect(result.dropped[0]?.reason).toMatch(/not found/)
    expect(result.stats.droppedEvidence).toBe(1)
  })

  it('drops evidence whose line numbers are not numbers', async () => {
    const result = await validatePoints(
      [
        withEvidence([
          { id: 'x', path: 'a.ts', startLine: '1', endLine: 1, snippet: 'export const answer = 42' },
        ]),
      ],
      root,
      'run1',
    )

    expect(result.dropped).toHaveLength(1)
    expect(result.stats.droppedEvidence).toBe(1)
  })

  it('counts every failing evidence item of a dropped point', async () => {
    const result = await validatePoints(
      [
        withEvidence([
          ev({ snippet: 'nope one' }),
          ev({ startLine: 41, endLine: 41, snippet: 'nope two' }),
          ev(),
        ]),
      ],
      root,
      'run1',
    )

    expect(result.kept).toEqual([])
    expect(result.stats.droppedEvidence).toBe(2)
    expect(result.dropped[0]?.reason).toMatch(/\+\d+ more/)
  })
})

describe('validatePoints — evidence that holds up is kept', () => {
  it('accepts a CRLF file, because both sides read the canonical text', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'crlf.ts', snippet: CRLF_SNIPPET })])],
      root,
      'run1',
    )

    expect(result.dropped).toEqual([])
    expect(result.kept).toHaveLength(1)
    expect(result.stats).toMatchObject({ evidenceRate: 1, droppedEvidence: 0 })
  })

  it('accepts a multi-line snippet that spans the CRLF lines', async () => {
    const result = await validatePoints(
      [
        withEvidence([
          ev({
            path: 'crlf.ts',
            startLine: 1,
            endLine: 2,
            snippet: `${CRLF_SNIPPET}\nexport const also = 1`,
          }),
        ]),
      ],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
  })

  it('accepts the second citation of duplicated code', async () => {
    const snippet = 'return n * 2\n}'
    const result = await validatePoints(
      [
        withEvidence([
          ev({ path: 'dup.ts', startLine: 3, endLine: 4, snippet }),
          ev({ path: 'dup.ts', startLine: 90, endLine: 91, snippet }),
        ]),
      ],
      root,
      'run1',
    )

    expect(result.dropped).toEqual([])
    expect(result.kept[0]?.theirs.evidence.map((item) => item.startLine)).toEqual([3, 90])
  })

  it('accepts the honest range of a snippet that starts with a newline', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'newline.ts', startLine: 2, endLine: 3, snippet: '\n  return 1' })])],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
  })

  it('accepts a snippet the model echoed back with CRLF', async () => {
    const canonical = 'export const answer = 42\nexport function double(n: number) {'
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 1, endLine: 2, snippet: canonical.replace(/\n/g, '\r\n') })])],
      root,
      'run1',
    )

    expect(result.dropped).toEqual([])
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.theirs.evidence[0]?.snippet).toBe(canonical)
  })

  it('accepts a file that starts with a BOM', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'bom.ts', snippet: BOM_SNIPPET })])],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
  })

  it('accepts a latin-1 file, accented characters included', async () => {
    const result = await validatePoints(
      [
        withEvidence([
          ev({ path: 'latin1.ts', startLine: 1, endLine: 1, snippet: '// café' }),
          ev({ path: 'latin1.ts', startLine: 2, endLine: 2, snippet: 'const montant = 1' }),
        ]),
      ],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.theirs.evidence).toHaveLength(2)
  })

  it('accepts a part of a line as well as a whole line', async () => {
    // Longer than the minimum length below, and still only part of line 3.
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 3, endLine: 3, snippet: 'return n * 2' })])],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
  })

  it('stamps ids from the run, path and line instead of trusting the model', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: './a.ts' })])],
      root,
      'run1',
    )

    const [evidence] = result.kept[0]?.theirs.evidence ?? []
    expect(evidence?.id).toBe(evidenceId('run1', 'a.ts', 1))
    expect(evidence?.id).not.toBe('model-supplied-id')
    // A path the model wrote sloppily still resolves to one canonical evidence path.
    expect(evidence?.path).toBe('a.ts')
  })
})

describe('validatePoints — no verifiable evidence downgrades instead of dropping', () => {
  it('downgrades a confident point that cites nothing', async () => {
    const result = await validatePoints(
      [withEvidence([], { confidence: 'high' })],
      root,
      'run1',
    )

    expect(result.dropped).toEqual([])
    expect(result.downgraded).toEqual([{ pointId: 'p1', reason: 'no verifiable evidence' }])
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.confidence).toBe('low')
    expect(result.kept[0]?.unknowns).toContain('no verifiable evidence')
  })

  it('downgrades a medium point that cites nothing too', async () => {
    const result = await validatePoints(
      [withEvidence([], { confidence: 'medium' })],
      root,
      'run1',
    )

    expect(result.downgraded).toHaveLength(1)
    expect(result.kept[0]?.confidence).toBe('low')
  })

  it('does not duplicate the unknown it appends', async () => {
    const result = await validatePoints(
      [withEvidence([], { confidence: 'low', unknowns: ['no verifiable evidence'] })],
      root,
      'run1',
    )

    expect(result.kept[0]?.unknowns).toEqual(['no verifiable evidence'])
  })

  it('reads a confidence the model capitalized or padded', async () => {
    for (const confidence of ['High', ' HIGH ']) {
      const result = await validatePoints(
        [withEvidence([ev()], { confidence: confidence as LearningPoint['confidence'] })],
        root,
        'run1',
      )

      expect(result.dropped).toEqual([])
      expect(result.kept).toHaveLength(1)
      expect(result.kept[0]?.confidence).toBe('high')
    }
  })

  it('leaves a high-confidence point alone when its evidence verifies', async () => {
    const result = await validatePoints([pt()], root, 'run1')

    expect(result.downgraded).toEqual([])
    expect(result.kept[0]?.confidence).toBe('high')
    expect(result.kept[0]?.unknowns).toEqual([])
  })
})

describe('validatePoints — stats describe what survived', () => {
  it('reports the verified share, the mean evidence count and the loss', async () => {
    const result = await validatePoints(
      [
        withEvidence([ev(), ev({ startLine: 2, endLine: 2, snippet: 'export function double' })]),
        withEvidence([], { id: 'p2' }),
        withEvidence([ev({ snippet: 'nope' })], { id: 'p3' }),
      ],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(1)
    expect(result.stats).toEqual({
      evidenceRate: 0.5,
      droppedEvidence: 1,
      avgEvidence: 1,
    })
  })

  it('counts one snippet repeated five times once', async () => {
    const copies = Array.from({ length: 5 }, () => ev())
    const result = await validatePoints([withEvidence(copies)], root, 'run1')

    expect(result.kept[0]?.theirs.evidence).toHaveLength(1)
    expect(result.stats).toEqual({ evidenceRate: 1, droppedEvidence: 0, avgEvidence: 1 })
  })

  it('rounds the mean to two decimals', async () => {
    const result = await validatePoints(
      [
        withEvidence([ev()], { id: 'p1' }),
        withEvidence([ev()], { id: 'p2' }),
        withEvidence([ev()], { id: 'p3' }),
        withEvidence(
          [ev(), ev({ startLine: 3, endLine: 3, snippet: 'return n * 2' })],
          { id: 'p4' },
        ),
      ],
      root,
      'run1',
    )

    expect(result.stats.avgEvidence).toBe(1.25)
  })

  it('is all zeros when nothing was kept', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 999, endLine: 999, snippet: 'x' })])],
      root,
      'run1',
    )

    expect(result.stats).toEqual({ evidenceRate: 0, droppedEvidence: 1, avgEvidence: 0 })
  })
})

describe('validatePoints — malformed input never throws', () => {
  it('drops points whose shape is wrong and keeps the sound ones', async () => {
    const malformed: unknown[] = [
      null,
      'not a point',
      {},
      { id: 'no-theirs' },
      { id: 'null-evidence', theirs: { evidence: null } },
      { id: 'bad-confidence', theirs: { evidence: [] }, confidence: 'certain' },
      { id: 'evidence-object', theirs: { evidence: {} } },
    ]

    const result = await validatePoints(
      [...malformed, pt()] as unknown as LearningPoint[],
      root,
      'run1',
    )

    expect(result.dropped).toHaveLength(malformed.length)
    for (const entry of result.dropped) expect(entry.reason).not.toBe('')
    expect(result.kept).toHaveLength(1)
    expect(result.dropped.map((entry) => entry.pointId)).toContain('null-evidence')
  })

  it('survives a non-array point list', async () => {
    const result = await validatePoints(
      null as unknown as LearningPoint[],
      root,
      'run1',
    )

    expect(result).toEqual({
      kept: [],
      downgraded: [],
      dropped: [],
      stats: { evidenceRate: 0, droppedEvidence: 0, avgEvidence: 0 },
    })
  })
})

describe('validatePoints — symlinks and read bounds', () => {
  it('drops a path that is lexically inside the root but is a symlink out of it', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'vendor/link-dir/secret.ts', snippet: 'export const secret = 1' })])],
      root,
      'run1',
    )

    expect(result.kept).toEqual([])
    expect(result.dropped[0]?.reason).toMatch(/outside the analysed root/)
    // Refused before a single byte was read.
    expect(canonicalCalls.paths).toEqual([])
  })

  it('drops a file symlink that points outside the root', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'vendor/link-secret.ts', snippet: 'export const secret = 1' })])],
      root,
      'run1',
    )

    expect(result.kept).toEqual([])
    expect(result.dropped[0]?.reason).toMatch(/outside the analysed root/)
    expect(canonicalCalls.paths).toEqual([])
  })

  it('still accepts a symlink that points at a file inside the root', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'vendor/link-inside.ts', snippet: 'export const answer = 42' })])],
      root,
      'run1',
    )

    expect(result.dropped).toEqual([])
    expect(result.kept).toHaveLength(1)
    // Evidence keeps the path the model cited, not the link target.
    expect(result.kept[0]?.theirs.evidence[0]?.path).toBe('vendor/link-inside.ts')
  })

  it('refuses a symlink to a FIFO instead of hanging on it', async () => {
    try {
      execFileSync('mkfifo', [path.join(root, 'pipe.ts')])
      symlinkSync(path.join(root, 'pipe.ts'), path.join(root, 'vendor', 'link-pipe.ts'))
    } catch {
      // No mkfifo on this platform: the FIFO case cannot be created at all.
      return
    }

    const result = await validatePoints(
      [withEvidence([ev({ path: 'vendor/link-pipe.ts', snippet: 'export const answer = 42' })])],
      root,
      'run1',
    )

    expect(result.kept).toEqual([])
    expect(result.dropped[0]?.reason).toMatch(/regular file/)
    expect(canonicalCalls.paths).toEqual([])
  })

  it('refuses a file larger than the read cap, naming the cap', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'huge.ts', startLine: 1, endLine: 1, snippet: 'const padded = 1' })])],
      root,
      'run1',
    )

    expect(result.kept).toEqual([])
    expect(result.dropped[0]?.reason).toContain(String(MAX_EVIDENCE_BYTES))
    expect(result.dropped[0]?.reason).toMatch(/cap/)
    // The cap is enforced before the read, so a huge file is never buffered.
    expect(canonicalCalls.paths).toEqual([])
  })
})

describe('validatePoints — a scope bounds what can be cited', () => {
  const scopeOf = (paths: string[]): Scope => ({
    root,
    files: paths.map((filePath) => ({
      path: filePath,
      bytes: 16,
      lines: 1,
      language: 'ts',
    })),
    excluded: [{ reason: 'vendored', count: 2 }],
    totals: { files: paths.length, bytes: 16 * paths.length, lines: paths.length },
    byLanguage: { ts: paths.length },
  })

  it('refuses evidence for a path the scope excluded', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'crlf.ts', snippet: CRLF_SNIPPET })])],
      root,
      'run1',
      scopeOf(['a.ts']),
    )

    expect(result.kept).toEqual([])
    expect(result.dropped[0]?.reason).toMatch(/scope/)
    expect(canonicalCalls.paths).toEqual([])
  })

  it('still accepts evidence for a path the scope kept', async () => {
    const result = await validatePoints(
      [withEvidence([ev()])],
      root,
      'run1',
      scopeOf(['a.ts']),
    )

    expect(result.dropped).toEqual([])
    expect(result.kept).toHaveLength(1)
  })

  it('applies no scope check when no scope is given', async () => {
    const result = await validatePoints(
      [withEvidence([ev({ path: 'crlf.ts', snippet: CRLF_SNIPPET })])],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
  })
})

describe('validatePoints — every field of a point is checked', () => {
  it('drops the wrong-typed point the report would crash on', async () => {
    const broken = {
      id: 'p1',
      title: 42,
      problem: null,
      alternatives: null,
      theirs: { summary: 's', evidence: [] },
      mechanism: null,
      tradeoffs: null,
      confidence: 'high',
    }

    const result = await validatePoints([broken] as unknown as LearningPoint[], root, 'run1')

    // Dropped, not downgraded: a low-confidence point with a null `problem` is
    // still a crash waiting in the renderer.
    expect(result.kept).toEqual([])
    expect(result.downgraded).toEqual([])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.pointId).toBe('p1')
    expect(result.dropped[0]?.reason).toMatch(/title/)
  })

  it('names the field that is unusable', async () => {
    const cases: Array<[string, unknown]> = [
      ['problem', { ...pt(), problem: { constraint: 'c' } }],
      ['alternatives', { ...pt(), alternatives: [{}] }],
      ['tradeoffs', { ...pt(), tradeoffs: [{ cost: 'c' }] }],
      ['recipe', { ...pt(), recipe: { prereqs: ['p'], minimalForm: 1, avoidWhen: [] } }],
      ['unknowns', { ...pt(), unknowns: [1] }],
      ['kind', { ...pt(), kind: 'vibes' }],
    ]

    for (const [field, broken] of cases) {
      const result = await validatePoints([broken as LearningPoint], root, 'run1')
      expect(result.kept).toEqual([])
      expect(result.dropped[0]?.reason).toContain(field)
    }
  })

  it('keeps a well-formed point whose evidence is missing, downgraded not dropped', async () => {
    const result = await validatePoints([withEvidence([], { id: 'p2' })], root, 'run1')

    expect(result.dropped).toEqual([])
    expect(result.downgraded).toEqual([{ pointId: 'p2', reason: 'no verifiable evidence' }])
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.confidence).toBe('low')
    // The renderer's fields survive intact: this is the downgrade, not a drop.
    expect(result.kept[0]?.alternatives).toEqual([{ approach: 'inline', cost: 'repetition' }])
    expect(result.kept[0]?.problem).toEqual({ constraint: 'c', stakes: 's' })
  })

  it('keeps a point that carries a well-formed recipe', async () => {
    const result = await validatePoints(
      [
        withEvidence([ev()], {
          recipe: { prereqs: ['node'], minimalForm: 'const d = (n) => n * 2', avoidWhen: [] },
        }),
      ],
      root,
      'run1',
    )

    expect(result.kept).toHaveLength(1)
  })
})

describe('evidenceId', () => {
  it('is the run id plus six hex characters of sha256(path, line)', () => {
    const id = evidenceId('run1', 'a.ts', 1)
    expect(id).toMatch(/^run1-[0-9a-f]{6}$/)
  })

  it('is stable for the same inputs and distinct across path, line and run', () => {
    expect(evidenceId('run1', 'a.ts', 1)).toBe(evidenceId('run1', 'a.ts', 1))
    expect(evidenceId('run1', 'a.ts', 1)).not.toBe(evidenceId('run1', 'a.ts', 2))
    expect(evidenceId('run1', 'a.ts', 1)).not.toBe(evidenceId('run1', 'b.ts', 1))
    expect(evidenceId('run1', 'a.ts', 1)).not.toBe(evidenceId('run2', 'a.ts', 1))
  })

  it('does not collide between a shifted path and a shifted line', () => {
    // Without the NUL separator 'a.ts' + 11 and 'a.t' + 's11' style inputs would.
    expect(evidenceId('run', 'a1', 23)).not.toBe(evidenceId('run', 'a12', 3))
  })
})

describe('validatePoints — reads', () => {
  it('canonicalizes each referenced file at most once per call', async () => {
    await validatePoints(
      [
        withEvidence([ev(), ev({ startLine: 2, endLine: 2, snippet: 'export function' })], { id: 'p1' }),
        withEvidence([ev({ startLine: 3, endLine: 3, snippet: 'return n * 2' })], { id: 'p2' }),
        withEvidence([ev({ path: 'missing.ts' })], { id: 'p3' }),
        withEvidence([ev({ path: 'missing.ts' })], { id: 'p4' }),
      ],
      root,
      'run1',
    )

    // a.ts is the only path that is ever read: a missing path is refused during
    // real-path resolution, before canonicalization, so it never reaches a read.
    expect(canonicalCalls.paths).toHaveLength(1)
    // The path is the resolved one, so nothing can repoint a symlink between
    // the containment check and the read.
    expect(canonicalCalls.paths[0]).toBe(realpathSync(path.join(root, 'a.ts')))
  })
})
