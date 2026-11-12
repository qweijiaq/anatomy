/**
 * The product's whole claim lives in this file: a snippet the model wrote is
 * checked against the canonical text of the file on disk, and anything that
 * cannot be checked is dropped or downgraded — never trusted.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Evidence, LearningPoint } from '../src/contracts/types.js'
import { evidenceId, validatePoints } from '../src/kernel/evidence.js'

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
writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1\n')

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
    const result = await validatePoints(
      [withEvidence([ev({ startLine: 3, endLine: 3, snippet: 'n * 2' })])],
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

    // One canonicalization per distinct absolute path: a.ts and missing.ts.
    expect(canonicalCalls.paths).toHaveLength(2)
    expect(canonicalCalls.paths[0]).toBe(path.join(root, 'a.ts'))
  })
})
