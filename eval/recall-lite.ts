/**
 * Candidate recall: does the kernel even look in the right place?
 *
 *   node --experimental-strip-types eval/recall-lite.ts [<gold-file> ...]
 *
 * `eval/run.ts` measures the whole product and therefore needs a model key.
 * This one measures only the deterministic half — "did any candidate land on the
 * lines the gold set says matter?" — so a rule change can be judged before
 * anyone spends a token on it. A point can never be produced from a candidate
 * that was never found, so this is the ceiling on recall; the model cannot
 * recover what the kernel did not offer it.
 *
 * It reuses `matchGold`, so the number here and the number in the unit tests mean
 * the same thing. Candidates are single lines, so each becomes a one-line range.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('./ts-resolve.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const { matchGold, readGold } = await import('../src/eval/match.js')
const { scanRepo } = await import('../src/kernel/pipeline.js')
const { closeRun } = await import('../src/store/runs.js')

const goldDir = path.join(here, 'gold')
const requested = process.argv.slice(2)
const files =
  requested.length > 0
    ? requested
    : readdirSync(goldDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(goldDir, name))

let goldTotal = 0
let goldHit = 0
const rows: string[] = []

for (const file of files) {
  const gold = readGold(JSON.parse(readFileSync(file, 'utf8')))
  if (gold === null) {
    process.stderr.write(`skip ${path.basename(file)}: not a gold file\n`)
    continue
  }

  // A large `topK` on purpose: this measures what the rules *could* find, not
  // what the model budget would have kept.
  const scanned = await scanRepo(gold.repo, { ref: gold.sha, topK: 500 })
  await closeRun(scanned.run)

  const produced = scanned.candidates.map((candidate) => ({
    path: candidate.path,
    startLine: candidate.line,
    endLine: candidate.line,
  }))
  const result = matchGold(produced, gold.points)

  goldTotal += gold.points.length
  goldHit += result.matched.length
  rows.push(
    `${path.basename(file).padEnd(24)} candidates ${String(scanned.candidates.length).padStart(3)}` +
      `  gold ${gold.points.length}  hit ${result.matched.length}` +
      `  recall ${(result.recall * 100).toFixed(0)}%`,
  )
}

process.stdout.write(`${rows.join('\n')}\n\n`)
process.stdout.write(
  `overall candidate recall: ${goldHit}/${goldTotal} = ` +
    `${goldTotal === 0 ? '0' : ((goldHit / goldTotal) * 100).toFixed(0)}%\n`,
)
process.stdout.write(
  'This is the ceiling: a gold point with no candidate can never become a learning point.\n',
)
