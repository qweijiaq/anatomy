/**
 * Ranking is the product's last defence against its stated anti-goal: a report
 * that lists a hundred mediocre points instead of five worth reading. These
 * tests pin the three rules that make the order mean something — the score is
 * the originating candidate's, not the model's self-assessment; a point backed
 * by real evidence always outranks one that is not; two points about the same
 * decision in the same file are one point, not two.
 */

import { describe, expect, it } from 'vitest'

import type {
  Candidate,
  Evidence,
  LearningPoint,
  LearningPointKind,
  SignalKind,
} from '../src/contracts/types.js'
import { rankPoints } from '../src/writing/rank.js'

function evidenceOn(
  path: string,
  startLine: number,
  endLine: number = startLine,
): Evidence {
  return { id: `ev-${path}-${startLine}`, path, startLine, endLine, snippet: 'const x = 1' }
}

function pointOf(
  id: string,
  kind: LearningPointKind,
  evidence: Evidence[],
  over: Partial<LearningPoint> = {},
): LearningPoint {
  return {
    id,
    title: `title ${id}`,
    kind,
    problem: { constraint: 'c', stakes: 's' },
    alternatives: [{ approach: 'a', cost: 'b' }],
    theirs: { summary: 'summary', evidence },
    mechanism: 'mechanism',
    tradeoffs: [{ cost: 'c', whenItHurts: 'w' }],
    confidence: 'medium',
    unknowns: [],
    recipe: null,
    ...over,
  }
}

function candidateOf(
  id: string,
  path: string,
  line: number,
  kind: SignalKind,
  score: number,
): Candidate {
  return { id, path, line, kind, score, matched: [] }
}

const ids = (points: LearningPoint[]): string[] => points.map((point) => point.id)

describe('rankPoints — score comes from the candidate, not the model', () => {
  it('orders points by the score of the candidate their evidence came from', () => {
    const a = pointOf('a', 'architecture', [evidenceOn('src/a.ts', 12)])
    const b = pointOf('b', 'algorithm', [evidenceOn('src/b.ts', 40)])
    const c = pointOf('c', 'testing', [evidenceOn('src/c.ts', 7)])

    const ranked = rankPoints(
      [b, a, c],
      [
        candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.9),
        candidateOf('sig-b', 'src/b.ts', 40, 'complexity', 0.5),
        candidateOf('sig-c', 'src/c.ts', 7, 'test-spec', 0.2),
      ],
    )

    expect(ids(ranked)).toEqual(['a', 'b', 'c'])
  })

  it('matches a candidate that sits anywhere inside the cited range', () => {
    const wide = pointOf('wide', 'architecture', [evidenceOn('src/a.ts', 10, 30)])
    const exact = pointOf('exact', 'algorithm', [evidenceOn('src/b.ts', 5)])

    const ranked = rankPoints(
      [wide, exact],
      [
        candidateOf('sig-a', 'src/a.ts', 24, 'abstraction', 0.7),
        candidateOf('sig-b', 'src/b.ts', 5, 'complexity', 0.4),
      ],
    )

    expect(ids(ranked)).toEqual(['wide', 'exact'])
  })

  it('prefers a path match over kind similarity', () => {
    // `p` cites a real candidate worth 0.2; its kind is also close to another
    // candidate worth 0.9. The originating candidate is the one on its path.
    const p = pointOf('p', 'testing', [evidenceOn('src/a.ts', 12)])
    const q = pointOf('q', 'architecture', [evidenceOn('src/q.ts', 3)])

    const ranked = rankPoints(
      [p, q],
      [
        candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.2),
        candidateOf('sig-t', 'src/other.ts', 9, 'test-spec', 0.9),
        candidateOf('sig-q', 'src/q.ts', 3, 'abstraction', 0.5),
      ],
    )

    expect(ids(ranked)).toEqual(['q', 'p'])
  })

  it('gives a point with no candidate at all the minimum candidate score', () => {
    const matched = pointOf('matched', 'testing', [evidenceOn('src/a.ts', 12)])
    const lonely = pointOf('lonely', 'algorithm', [evidenceOn('src/ghost.ts', 3)])

    const ranked = rankPoints(
      [lonely, matched],
      [
        candidateOf('sig-a', 'src/a.ts', 12, 'test-spec', 0.9),
        candidateOf('sig-z', 'src/z.ts', 8, 'abstraction', 0.3),
      ],
    )

    expect(ids(ranked)).toEqual(['matched', 'lonely'])
  })

  it('ranks a point with evidence above a higher-scored point without it', () => {
    const noEvidence = pointOf('no-evidence', 'testing', [])
    const withEvidence = pointOf('with-evidence', 'architecture', [
      evidenceOn('src/a.ts', 12),
    ])

    const ranked = rankPoints(
      [noEvidence, withEvidence],
      [
        candidateOf('sig-t', 'src/t.ts', 4, 'test-spec', 0.99),
        candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.05),
      ],
    )

    expect(ids(ranked)).toEqual(['with-evidence', 'no-evidence'])
    expect(ranked[0]?.theirs.evidence.length).toBe(1)
  })

  it('does not borrow an affinity score from a file the point never cites', () => {
    const borrowed = pointOf('borrowed', 'architecture', [evidenceOn('src/ghost.ts', 3)])
    const real = pointOf('real', 'testing', [evidenceOn('src/t.ts', 4)])

    const ranked = rankPoints(
      [borrowed, real],
      [
        candidateOf('sig-z', 'src/z.ts', 8, 'abstraction', 0.9),
        candidateOf('sig-t', 'src/t.ts', 4, 'test-spec', 0.8),
        candidateOf('sig-l', 'src/l.ts', 2, 'custom-infra', 0.1),
      ],
    )

    // `borrowed` cites src/ghost.ts, which has no candidate; repo-wide affinity
    // would hand it 0.9 from src/z.ts and put it above `real`, whose own signal
    // is 0.8. Its evidence paths carry no signal, so it gets the minimum.
    expect(ids(ranked)).toEqual(['real', 'borrowed'])
  })

  it('treats a reversed range as no evidence, even against a verifiable point', () => {
    const reversed = pointOf('reversed', 'architecture', [evidenceOn('src/a.ts', 20, 12)])
    const honest = pointOf('honest', 'testing', [evidenceOn('src/t.ts', 4)])
    const candidates = [
      candidateOf('sig-a', 'src/a.ts', 20, 'abstraction', 0.9),
      candidateOf('sig-t', 'src/t.ts', 4, 'test-spec', 0.1),
    ]

    // The reversed point both cites src/a.ts and has an affine kind, so it can
    // score 0.9 from that candidate; verifiability is what must sink it.
    expect(ids(rankPoints([reversed, honest], candidates))).toEqual(['honest', 'reversed'])
    expect(ids(rankPoints([reversed], candidates))).toEqual(['reversed'])
  })
})

describe('rankPoints — one decision is one point', () => {
  it('merges two points of the same kind that cite the same file, keeping the higher one', () => {
    const weaker = pointOf('weaker', 'architecture', [evidenceOn('src/a.ts', 80)])
    const stronger = pointOf('stronger', 'architecture', [evidenceOn('src/a.ts', 12)])

    const ranked = rankPoints(
      [weaker, stronger],
      [
        candidateOf('sig-w', 'src/a.ts', 80, 'abstraction', 0.4),
        candidateOf('sig-s', 'src/a.ts', 12, 'abstraction', 0.8),
      ],
    )

    expect(ids(ranked)).toEqual(['stronger'])
  })

  it('keeps points of different kinds on the same file apart', () => {
    const architecture = pointOf('architecture', 'architecture', [evidenceOn('src/a.ts', 12)])
    const testing = pointOf('testing', 'testing', [evidenceOn('src/a.ts', 40)])

    const ranked = rankPoints(
      [architecture, testing],
      [
        candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.8),
        candidateOf('sig-t', 'src/a.ts', 40, 'test-spec', 0.4),
      ],
    )

    expect(ids(ranked)).toEqual(['architecture', 'testing'])
  })

  it('does not merge the same kind across different files', () => {
    const one = pointOf('one', 'architecture', [evidenceOn('src/a.ts', 12)])
    const two = pointOf('two', 'architecture', [evidenceOn('src/b.ts', 12)])

    const ranked = rankPoints(
      [one, two],
      [
        candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.4),
        candidateOf('sig-b', 'src/b.ts', 12, 'abstraction', 0.3),
      ],
    )

    expect(ids(ranked)).toEqual(['one', 'two'])
  })

  it('never merges points that have no evidence to compare', () => {
    const one = pointOf('one', 'architecture', [])
    const two = pointOf('two', 'architecture', [])

    expect(ids(rankPoints([one, two], []))).toEqual(['one', 'two'])
  })
})

describe('rankPoints — pure and tolerant', () => {
  it('leaves its inputs untouched and is stable across calls', () => {
    const points = [
      pointOf('b', 'algorithm', [evidenceOn('src/b.ts', 5)]),
      pointOf('a', 'architecture', [evidenceOn('src/a.ts', 12)]),
      pointOf('a2', 'architecture', [evidenceOn('src/a.ts', 30)]),
    ]
    const candidates = [
      candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.5),
      candidateOf('sig-b', 'src/b.ts', 5, 'abstraction', 0.5),
      candidateOf('sig-a2', 'src/a.ts', 30, 'abstraction', 0.5),
    ]
    const before = JSON.parse(JSON.stringify({ points, candidates })) as unknown

    const first = ids(rankPoints(points, candidates))
    const second = ids(rankPoints(points, candidates))

    expect(first).toEqual(second)
    expect(points.map((point) => point.id)).toEqual(['b', 'a', 'a2'])
    expect(JSON.parse(JSON.stringify({ points, candidates }))).toEqual(before)
  })

  it('returns an empty list for an empty input and tolerates a malformed point', () => {
    expect(rankPoints([], [])).toEqual([])

    const broken = { ...pointOf('broken', 'tooling', []), theirs: undefined } as unknown as LearningPoint
    expect(rankPoints([broken], [])).toHaveLength(1)
  })

  it('skips non-object entries instead of throwing', () => {
    const good = pointOf('good', 'architecture', [evidenceOn('src/a.ts', 12)])
    const mixed = [null, undefined, good] as unknown as LearningPoint[]

    expect(ids(rankPoints(mixed, [candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.5)]))).toEqual([
      'good',
    ])
  })

  it('refuses an array smuggled into the points list', () => {
    // An array is an object at runtime; returning it as a LearningPoint would
    // hand the renderer a "point" with no title and no evidence.
    const smuggled = [[] as unknown as LearningPoint, pointOf('real', 'architecture', [])]

    expect(ids(rankPoints(smuggled, []))).toEqual(['real'])
  })

  it('skips a null evidence element instead of throwing', () => {
    const holed = pointOf('holed', 'architecture', [
      null as unknown as Evidence,
      evidenceOn('src/a.ts', 12),
    ])

    const ranked = rankPoints(
      [holed],
      [candidateOf('sig-a', 'src/a.ts', 12, 'abstraction', 0.5)],
    )

    expect(ids(ranked)).toEqual(['holed'])
  })
})
