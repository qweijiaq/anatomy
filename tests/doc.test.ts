/**
 * `ana doc` turns a stored report into something a repository can keep.
 *
 * The parts worth pinning are the ones that could quietly stop being true: every
 * point keeps its citation, the diagram is derived from the index rather than
 * invented, and a bundle contains the report and the snippets so it can be read
 * after the run directory is gone.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildDoc, diagramOf, parseDocArgs, runDoc, DocUsageError } from '../src/commands/doc.js'
import type { LearningPoint, StructureIndex } from '../src/contracts/types.js'

function point(): LearningPoint {
  return {
    id: 'p1',
    title: '固定容量环',
    kind: 'algorithm',
    problem: { constraint: '不搬移数组', stakes: '推送是热路径' },
    alternatives: [],
    theirs: {
      summary: '用固定槽位覆盖最旧值',
      evidence: [
        { id: 'e1', path: 'src/ring.ts', startLine: 1, endLine: 6, snippet: 'export class Ring {}' },
      ],
    },
    mechanism: '写入位置对容量取模',
    tradeoffs: [{ cost: '容量固定', whenItHurts: '需要动态增长时' }],
    confidence: 'high',
    unknowns: [],
    recipe: null,
  }
}

function structure(): StructureIndex {
  return {
    modules: [
      {
        path: 'src/ring.ts',
        imports: [{ from: 'src/ring.ts', specifier: './index.js', resolved: 'src/index.ts' }],
      },
      { path: 'src/index.ts', imports: [] },
    ],
    symbols: [],
    unresolved: 0,
    notes: [],
  }
}

function storedRun(baseDir: string): string {
  const runId = 'run-1'
  const dir = path.join(baseDir, runId)
  mkdirSync(dir, { recursive: true })
  const single = point()
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      runId,
      source: '/tmp/repo',
      ref: '',
      sha: 'abcdef1234567',
      subpath: '',
      engineVersion: '0.1.0',
      startedAt: '2026-11-01T00:00:00.000Z',
      status: 'complete',
      completedAt: '2026-11-01T00:01:00.000Z',
      lang: 'zh',
    }),
  )
  writeFileSync(path.join(dir, 'points.json'), JSON.stringify([single]))
  writeFileSync(
    path.join(dir, 'validation.json'),
    JSON.stringify({
      kept: [single],
      downgraded: [],
      dropped: [],
      stats: { evidenceRate: 1, droppedEvidence: 0, avgEvidence: 1 },
    }),
  )
  writeFileSync(
    path.join(dir, 'synthesis.json'),
    JSON.stringify({ problem: '一个环形缓冲区。', topFive: [single.title] }),
  )
  writeFileSync(path.join(dir, 'skipped.json'), JSON.stringify([{ path: '', line: 0, reason: '示例' }]))
  writeFileSync(
    path.join(dir, 'profile.json'),
    JSON.stringify({
      languages: { ts: 1 },
      manifests: [],
      entryPoints: [],
      hasTests: false,
      hasCi: false,
      hasDocs: false,
      notes: [],
    }),
  )
  writeFileSync(
    path.join(dir, 'scope.json'),
    JSON.stringify({
      root: '/tmp/repo',
      files: [],
      excluded: [],
      totals: { files: 1, bytes: 1, lines: 6 },
      byLanguage: {},
    }),
  )
  writeFileSync(path.join(dir, 'structure.json'), JSON.stringify(structure()))
  return runId
}

describe('ana doc', () => {
  it('keeps citations, the reading order and a derived diagram', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-doc-'))
    const runId = storedRun(baseDir)
    const result = await buildDoc(runId, { baseDir })

    expect(result.markdown).toContain('# repo — 架构笔记')
    expect(result.markdown).toContain('## 阅读顺序')
    expect(result.markdown).toContain('src/ring.ts:1-6')
    expect(result.markdown).toContain('```mermaid')
    expect(result.diagram).toContain('flowchart LR')
    expect(result.diagram).toContain('src/ring.ts')
    expect(result.evidence[0]).toMatchObject({ path: 'src/ring.ts', startLine: 1, endLine: 6 })
  })

  it('writes a portable bundle with the report and the snippets', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-doc-bundle-'))
    const runId = storedRun(baseDir)
    const bundle = path.join(baseDir, 'bundle')
    await runDoc(runId, { baseDir, bundle }, { out: { write: () => undefined } })

    for (const name of ['ARCHITECTURE.md', 'diagram.mmd', 'report.md', 'evidence.json', 'README.txt']) {
      expect(existsSync(path.join(bundle, name)), name).toBe(true)
    }
    expect(readFileSync(path.join(bundle, 'report.md'), 'utf8')).toContain('# repo')
    expect(readFileSync(path.join(bundle, 'evidence.json'), 'utf8')).toContain('src/ring.ts')
  })

  it('omits the diagram when the index is empty rather than drawing nothing', () => {
    expect(diagramOf(undefined)).toBe('')
    expect(diagramOf({ modules: [], symbols: [], unresolved: 0, notes: [] })).toBe('')
  })
})

describe('doc grammar', () => {
  it('takes a run id and output paths', () => {
    const args = parseDocArgs(['run-1', '--out', 'ARCHITECTURE.md', '--bundle', 'bundle'])
    expect(args).toMatchObject({ help: false, runId: 'run-1' })
    expect(args.help === false && args.options.out).toContain('ARCHITECTURE.md')
  })

  it('rejects a missing id and an unknown flag', () => {
    expect(() => parseDocArgs([])).toThrow(DocUsageError)
    expect(() => parseDocArgs(['run-1', '--bogus'])).toThrow(DocUsageError)
  })
})


describe('test linkage in the document', () => {
  it('names a test that mentions the cited file, and says it is not coverage', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-doc-tests-'))
    const repo = path.join(baseDir, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    mkdirSync(path.join(repo, 'tests'), { recursive: true })
    writeFileSync(path.join(repo, 'src', 'ring.ts'), 'export class Ring {}\n')
    writeFileSync(path.join(repo, 'tests', 'ring.test.ts'), "import { Ring } from '../src/ring.js'\n")
    const runId = storedRun(baseDir)
    // Point the run at the real checkout and at the two files.
    const manifestPath = path.join(baseDir, runId, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, source: repo }))
    const scopePath = path.join(baseDir, runId, 'scope.json')
    const scope = JSON.parse(readFileSync(scopePath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      scopePath,
      JSON.stringify({
        ...scope,
        root: repo,
        files: [
          { path: 'src/ring.ts', bytes: 1, lines: 1, language: 'ts' },
          { path: 'tests/ring.test.ts', bytes: 1, lines: 1, language: 'ts' },
        ],
      }),
    )
    const result = await buildDoc(runId, { baseDir })
    expect(result.markdown).toContain('提到它的测试')
    expect(result.markdown).toContain('tests/ring.test.ts')
    expect(result.markdown).toContain('不是覆盖率')
  })
})
