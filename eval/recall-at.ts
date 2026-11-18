/**
 * Recall at a candidate budget: what the model can still find at `--top N`.
 *
 * `recall-lite.ts` measures the ceiling with every candidate. That number is
 * useful for a rule change and useless for a budget decision: a run with `--top 6`
 * never sees candidates seven onward. This reads the scans `recall-lite` already
 * produced and reports recall at several budgets, so the default can be chosen
 * from data instead of taste.
 *
 * It scans nothing when a matching run exists; a missing repository is scanned
 * once with the same large topK as recall-lite.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('./ts-resolve.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const { matchGold, readGold } = await import('../src/eval/match.js')
const { scanRepo } = await import('../src/kernel/pipeline.js')
const { closeRun } = await import('../src/store/runs.js')

const goldDir = path.join(here, 'gold')
const runsDir = path.join(here, 'recall-sample', '.runs')
const BUDGETS = [4, 6, 8, 12, 20, 30, 500]

type Stored = { source: string; sha: string; candidates: Array<{ path: string; line: number }> }

function storedRuns(): Stored[] {
  if (!existsSync(runsDir)) return []
  const runs: Stored[] = []
  for (const name of readdirSync(runsDir)) {
    const dir = path.join(runsDir, name)
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
        source?: unknown
        sha?: unknown
      }
      const candidates = JSON.parse(readFileSync(path.join(dir, 'candidates.json'), 'utf8')) as Array<{
        path: string
        line: number
      }>
      if (typeof manifest.source === 'string' && Array.isArray(candidates)) {
        runs.push({ source: manifest.source, sha: typeof manifest.sha === 'string' ? manifest.sha : '', candidates })
      }
    } catch {
      // A half-written eval run is not a measurement.
    }
  }
  return runs
}

const runs = storedRuns()
const files = readdirSync(goldDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => path.join(goldDir, name))

const totals = new Map<number, { hit: number; gold: number; candidates: number; repos: number }>()
for (const budget of BUDGETS) totals.set(budget, { hit: 0, gold: 0, candidates: 0, repos: 0 })

for (const file of files) {
  const gold = readGold(JSON.parse(readFileSync(file, 'utf8')))
  if (gold === null) continue

  let stored = runs
    .filter((run) => run.source === gold.repo)
    .sort((a, b) => (a.sha === gold.sha ? -1 : 0) - (b.sha === gold.sha ? -1 : 0))[0]

  if (stored === undefined) {
    const scanned = await scanRepo(gold.repo, { ref: gold.sha, topK: 500, baseDir: runsDir })
    await closeRun(scanned.run)
    stored = {
      source: gold.repo,
      sha: gold.sha,
      candidates: scanned.candidates.map((candidate) => ({ path: candidate.path, line: candidate.line })),
    }
  }

  for (const budget of BUDGETS) {
    const produced = stored.candidates.slice(0, budget).map((candidate) => ({
      path: candidate.path,
      startLine: candidate.line,
      endLine: candidate.line,
    }))
    const result = matchGold(produced, gold.points)
    const row = totals.get(budget) as { hit: number; gold: number; candidates: number; repos: number }
    row.hit += result.matched.length
    row.gold += gold.points.length
    row.candidates += Math.min(budget, stored.candidates.length)
    row.repos += 1
  }
}

const lines = ['budget  recall   hit/gold   avg candidates']
for (const budget of BUDGETS) {
  const row = totals.get(budget) as { hit: number; gold: number; candidates: number; repos: number }
  const recall = row.gold === 0 ? 0 : row.hit / row.gold
  lines.push(
    `${String(budget).padStart(6)}  ${(recall * 100).toFixed(1).padStart(5)}%  ${String(row.hit).padStart(3)}/${String(row.gold).padEnd(4)}  ${(row.candidates / Math.max(1, row.repos)).toFixed(1)}`,
  )
}
process.stdout.write(`${lines.join('\n')}\n`)
