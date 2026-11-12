/**
 * The eval runner: gold files in, recall out.
 *
 *   node --experimental-strip-types eval/run.ts [<gold-file> ...]
 *
 * A gold file says "the interesting decision in this repository is at
 * `index.js:26-36`, and here is what it is". This script analyses each gold
 * repository through the real pipeline, reads back the points the run persisted,
 * and scores them with `matchGold` — the same scorer the unit tests use, so the
 * number a reader sees here is the number the tests define.
 *
 * Three things this file deliberately does *not* do:
 *
 * - It does not score the prose. A produced point is located by the evidence it
 *   kept: `validatePoints` has already thrown away every citation that was not
 *   verbatim in the file, so the surviving evidence is the set of places the run
 *   will stand behind. A point whose evidence was all invented therefore cannot
 *   score, which is exactly the behaviour being measured.
 * - It does not run against a branch. The gold ranges are line numbers in one
 *   commit, so `ref` is the pinned `sha` and never `main`: a floating ref would
 *   silently rescore the same claims against different code.
 * - It does not treat missing credentials as a failure. An eval that cannot run
 *   says so in one line and exits 0; a laptop with no key is not a broken
 *   repository. Any other error is a real one and exits 1.
 *
 * Never imported by `src/`: it is the only place that spends tokens, and nothing
 * in the product should be able to reach it.
 */

import { readFile, readdir } from 'node:fs/promises'
import { register } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { GoldFile } from '../src/eval/match.js'

/*
 * Node's type stripping executes the sources as written, and those sources import
 * each other by the `./x.js` names `tsc` emits — no such file exists on disk. The
 * hook points those specifiers at the `.ts` beside them. It must be registered
 * before the pipeline is loaded, because a resolve hook only sees modules that are
 * resolved after it registers, which is why the imports below are dynamic.
 */
register(new URL('./ts-resolve.mjs', import.meta.url))

const { matchGold, readGold } = await import('../src/eval/match.js')
const { runAnalyze } = await import('../src/commands/analyze.js')

/** Where the gold set lives, resolved from this file so the cwd does not matter. */
const GOLD_DIR = fileURLToPath(new URL('./gold/', import.meta.url))

/** Candidates per run. Fixed so two runs of the eval are comparable. */
const TOP = 8

const USAGE = 'usage: node --experimental-strip-types eval/run.ts [--api-key <key>] [<gold-file> ...]'

type Options = { apiKey: string | undefined; files: string[] }

type Location = { path: string; startLine: number; endLine: number }

type Row = {
  /** The gold file's base name: the repository's short name in the table. */
  name: string
  runId: string
  gold: GoldFile
  recall: number
  evidenceRate: number | null
  droppedEvidence: number | null
  /** Per gold point, in gold order: did the run land on it? */
  hits: boolean[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Flags first, files last; `--` is not special because no path here starts with `-`. */
function parseArgs(argv: string[]): Options {
  const files: string[] = []
  let apiKey: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue

    if (arg === '--api-key') {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new Error(`--api-key needs a value\n${USAGE}`)
      apiKey = value
      index += 1
      continue
    }

    if (arg.startsWith('--api-key=')) {
      const value = arg.slice('--api-key='.length)
      if (value === '') throw new Error(`--api-key needs a value\n${USAGE}`)
      apiKey = value
      continue
    }

    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${USAGE}`)
    files.push(arg)
  }

  return { apiKey, files }
}

async function readJsonFile(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
}

/** An artifact of a run, or `null` when the run did not write it. */
async function readArtifactFile(file: string): Promise<unknown> {
  try {
    return await readJsonFile(file)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Every location the run produced, taken from the evidence each point kept.
 *
 * A `LearningPoint` has no path of its own: it makes a claim and cites the lines
 * that back it. Validation has already dropped the citations that did not resolve
 * to a verbatim snippet, so what is left is the run's own answer to "where".
 */
function locationsOf(points: unknown): Location[] {
  const locations: Location[] = []
  if (!Array.isArray(points)) return locations

  for (const point of points) {
    if (!isRecord(point)) continue
    const theirs = point['theirs']
    if (!isRecord(theirs)) continue
    const evidence = theirs['evidence']
    if (!Array.isArray(evidence)) continue

    for (const item of evidence) {
      if (!isRecord(item)) continue
      const producedPath = item['path']
      const startLine = item['startLine']
      const endLine = item['endLine']
      if (typeof producedPath !== 'string' || producedPath === '') continue
      if (typeof startLine !== 'number' || typeof endLine !== 'number') continue
      locations.push({ path: producedPath, startLine, endLine })
    }
  }

  return locations
}

/** The trust numbers the pipeline recorded; `null` when the artifact is absent. */
function statsOf(validation: unknown): Pick<Row, 'evidenceRate' | 'droppedEvidence'> {
  const empty = { evidenceRate: null, droppedEvidence: null }
  if (!isRecord(validation)) return empty
  const stats = validation['stats']
  if (!isRecord(stats)) return empty
  return {
    evidenceRate: typeof stats['evidenceRate'] === 'number' ? stats['evidenceRate'] : null,
    droppedEvidence:
      typeof stats['droppedEvidence'] === 'number' ? stats['droppedEvidence'] : null,
  }
}

async function defaultGoldFiles(): Promise<string[]> {
  const entries = await readdir(GOLD_DIR)
  return entries
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => path.join(GOLD_DIR, entry))
}

async function evaluate(file: string, apiKey: string): Promise<Row> {
  const gold = readGold(await readJsonFile(file))
  if (gold === null) {
    throw new Error(`${path.basename(file)} is not a gold file: need repo, ref, sha and points[]`)
  }

  // `ref: gold.sha`, never `gold.ref`: the ranges are line numbers in one commit.
  const { runId, reportPath } = await runAnalyze(gold.repo, { ref: gold.sha, top: TOP, apiKey })
  const runDir = path.dirname(reportPath)

  const produced = locationsOf(await readArtifactFile(path.join(runDir, 'points.json')))
  const trust = statsOf(await readArtifactFile(path.join(runDir, 'validation.json')))
  const result = matchGold(produced, gold.points)

  // A per-point hit is the scorer's own rule applied to one point, not a second
  // copy of "same file and overlapping range" that could drift from it.
  const hits = gold.points.map((point) => matchGold(produced, [point]).recall === 1)

  return {
    name: path.basename(file, '.json'),
    runId,
    gold,
    recall: result.recall,
    ...trust,
    hits,
  }
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'right' ? text.padStart(width) : text.padEnd(width)
}

function number(value: number | null, digits = 2): string {
  return value === null ? '-' : value.toFixed(digits)
}

function printTable(rows: Row[]): void {
  const nameWidth = Math.max('repo'.length, ...rows.map((row) => row.name.length))
  const header = [
    pad('repo', nameWidth),
    pad('recall', 6, 'right'),
    pad('evidence', 8, 'right'),
    pad('dropped', 7, 'right'),
  ].join('  ')

  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of rows) {
    console.log(
      [
        pad(row.name, nameWidth),
        pad(number(row.recall), 6, 'right'),
        pad(number(row.evidenceRate), 8, 'right'),
        pad(row.droppedEvidence === null ? '-' : String(row.droppedEvidence), 7, 'right'),
      ].join('  '),
    )
  }
}

function printPoints(row: Row): void {
  const found = row.hits.filter((hit) => hit).length
  console.log(`\n${row.name}: ${found}/${row.gold.points.length} hit, run ${row.runId}`)

  const labels = row.gold.points.map((point) => `${point.path}:${point.startLine}-${point.endLine}`)
  const width = Math.max(0, ...labels.map((label) => label.length))

  for (let index = 0; index < row.gold.points.length; index += 1) {
    const point = row.gold.points[index]
    if (point === undefined) continue
    const verdict = row.hits[index] === true ? 'hit ' : 'miss'
    console.log(`  ${verdict} ${pad(labels[index] ?? '', width)}  ${point.why}`)
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv)
  const fromEnv = process.env['ANA_API_KEY']
  const apiKey = options.apiKey ?? (typeof fromEnv === 'string' ? fromEnv.trim() : '')

  if (apiKey === '') {
    console.log(
      'eval: no credentials (ANA_API_KEY unset and no --api-key), so nothing was analysed; ' +
        'an eval that cannot run is not a failure.',
    )
    return 0
  }

  const files = options.files.length > 0 ? options.files : await defaultGoldFiles()
  if (files.length === 0) throw new Error(`no gold files under ${GOLD_DIR}`)

  const rows: Row[] = []
  for (const file of files) rows.push(await evaluate(file, apiKey))

  printTable(rows)
  for (const row of rows) printPoints(row)
  return 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(`eval: ${messageOf(error)}`)
  process.exitCode = 1
}
