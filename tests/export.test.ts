/**
 * The dossier's promise is arithmetic: one paid analysis, many files, zero extra
 * model calls unless the caller asks for enrichment. These tests pin both halves.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  exportDossier,
  ExportArgsError,
  parseExportArgs,
} from '../src/commands/export.js'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/writing/client.js'
import {
  cleanupTemporaryDirs,
  storedRun,
  temporaryDir,
} from './helpers/run-fixture.js'

afterAll(cleanupTemporaryDirs)

function runDir(): { baseDir: string; runId: string } {
  const baseDir = temporaryDir('ana-export-')
  const runId = 'run-1'
  storedRun(baseDir, runId, {
    evidence: { id: 'e1', path: 'src/a.ts', startLine: 1, endLine: 3, snippet: 'const a = 1' },
  })
  return { baseDir, runId }
}

function enrichClient(): ModelClient {
  return {
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      return {
        json: {
          glossary: [
            { term: '固定容量', definition: '容量不增长。', citations: ['src/a.ts:1-3'] },
            { term: '编造', definition: '不该出现。', citations: ['src/other.ts:1-2'] },
          ],
          faq: [
            { question: '会丢写吗？', answer: '不检查返回值时会。', citations: ['src/a.ts:1-3'] },
          ],
        },
        usage: { in: 10, out: 5 },
      }
    },
  }
}

describe('ana export', () => {
  it('writes the dossier with no model calls', async () => {
    const { baseDir, runId } = runDir()
    const result = await exportDossier(runId, { baseDir, out: path.join(baseDir, 'out') })
    expect(result.modelCalls).toBe(0)
    expect(result.files).toEqual(
      expect.arrayContaining([
        'README.md',
        'SUMMARY.md',
        'ARCHITECTURE.md',
        'DECISIONS.md',
        'RISKS.md',
        'ONBOARDING.md',
        'HOTSPOTS.md',
        'QUIZ.md',
        'evidence.json',
        'report.md',
        'manifest.json',
      ]),
    )
    const read = (name: string): string => readFileSync(path.join(result.dir, name), 'utf8')
    expect(read('SUMMARY.md')).toContain('src/a.ts:1-3')
    expect(read('DECISIONS.md')).toContain('固定容量')
    expect(read('QUIZ.md')).toContain('不是新的主张')
    expect(JSON.parse(read('manifest.json'))).toMatchObject({ modelCalls: 0 })
    expect(readdirSync(result.dir).length).toBe(result.files.length)
  })

  it('adds glossary and FAQ from one call, dropping uncited items', async () => {
    const { baseDir, runId } = runDir()
    const result = await exportDossier(runId, {
      baseDir,
      out: path.join(baseDir, 'out'),
      enrich: true,
      client: enrichClient(),
    })
    expect(result.modelCalls).toBe(1)
    const glossary = readFileSync(path.join(result.dir, 'GLOSSARY.md'), 'utf8')
    expect(glossary).toContain('固定容量')
    expect(glossary).not.toContain('编造')
    expect(readFileSync(path.join(result.dir, 'FAQ.md'), 'utf8')).toContain('会丢写吗')
  })

  it('keeps the deterministic files when enrichment fails', async () => {
    const { baseDir, runId } = runDir()
    const bad: ModelClient = {
      async complete(): Promise<ModelResponse> {
        throw new Error('provider said no')
      },
    }
    const result = await exportDossier(runId, {
      baseDir,
      out: path.join(baseDir, 'out'),
      enrich: true,
      client: bad,
    })
    expect(result.modelCalls).toBe(0)
    expect(result.enrichError).toContain('provider said no')
    expect(result.files).toContain('SUMMARY.md')
  })
})

describe('export grammar', () => {
  it('takes a run id, output directory and enrichment flags', () => {
    const args = parseExportArgs(['run-1', '--out', '/tmp/out', '--enrich', '--json'])
    expect(args).toMatchObject({ help: false, runId: 'run-1', json: true })
    expect(args.help === false && args.options.enrich).toBe(true)
  })

  it('rejects a missing id and an unknown flag', () => {
    expect(() => parseExportArgs([])).toThrow(ExportArgsError)
    expect(() => parseExportArgs(['run-1', '--bogus'])).toThrow(ExportArgsError)
  })
})
