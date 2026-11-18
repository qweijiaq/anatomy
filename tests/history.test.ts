/**
 * `ana history` is metadata, not evidence — and it must refuse when it has no
 * local checkout instead of inventing a commit.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  formatHistory,
  HistoryUsageError,
  parseHistoryArgs,
  runHistory,
} from '../src/commands/history.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

function fixture(): { repo: string; baseDir: string; runId: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ana-history-'))
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'ring.ts'), 'export class Ring {}\n')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'introduce the ring buffer')

  const baseDir = path.join(root, 'runs')
  const runId = 'run-1'
  const dir = path.join(baseDir, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      runId,
      source: repo,
      ref: '',
      sha: 'abc',
      subpath: '',
      engineVersion: '0.1.0',
      startedAt: '2026-11-01T00:00:00.000Z',
      status: 'complete',
      lang: 'zh',
    }),
  )
  writeFileSync(
    path.join(dir, 'points.json'),
    JSON.stringify([
      {
        id: 'p1',
        title: 'ring',
        kind: 'algorithm',
        problem: { constraint: '', stakes: '' },
        alternatives: [],
        theirs: {
          summary: '',
          evidence: [{ id: 'e', path: 'src/ring.ts', startLine: 1, endLine: 1, snippet: 'x' }],
        },
        mechanism: '',
        tradeoffs: [],
        confidence: 'high',
        unknowns: [],
        recipe: null,
      },
    ]),
  )
  return { repo, baseDir, runId }
}

describe('ana history', () => {
  it('names the last commit behind a cited file', async () => {
    const { baseDir, runId } = fixture()
    const result = await runHistory(runId, { baseDir })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.path).toBe('src/ring.ts')
    expect(result.entries[0]?.subject).toBe('introduce the ring buffer')
    expect(formatHistory(result.source, result.entries)).toContain('introduce the ring buffer')
    expect(formatHistory(result.source, result.entries)).toContain('not evidence')
  })

  it('refuses a source that is not a local checkout', async () => {
    const { baseDir, runId } = fixture()
    const manifestPath = path.join(baseDir, runId, 'manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        runId,
        source: 'https://github.com/acme/repo',
        ref: 'main',
        sha: 'abc',
        subpath: '',
        engineVersion: '0.1.0',
        startedAt: '2026-11-01T00:00:00.000Z',
        status: 'complete',
      }),
    )
    await expect(runHistory(runId, { baseDir })).rejects.toBeInstanceOf(HistoryUsageError)
  })

  it('parses a run id, --json and --dir', () => {
    const args = parseHistoryArgs(['run-1', '--json', '--dir', '/tmp/runs'])
    expect(args).toMatchObject({ help: false, runId: 'run-1', json: true })
    expect(() => parseHistoryArgs([])).toThrow(HistoryUsageError)
  })
})
