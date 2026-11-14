/**
 * Build the blind-review sample: the best points this product can produce today.
 *
 *   node --experimental-strip-types eval/sample-points.ts [<gold-file> ...]
 *
 * It runs the real pipeline over the gold repositories with the *deterministic
 * stub* model — so no provider key and no cost — and writes one markdown file per
 * gold repository containing the points that model would produce, formatted
 * exactly as a reader sees them. That file is what `eval/quality-prompt.md` asks
 * someone to score.
 *
 * The stub is honest about its limits, which is the point: if the output looks
 * thin here, the product is thin, because nothing between the kernel and the page
 * is being simulated. What *is* simulated is the judgement — a real model would
 * write better prose from the same evidence. This measures the shape of the page,
 * not the talent of the writer.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('./ts-resolve.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const { readGold } = await import('../src/eval/match.js')
const { runAnalyze } = await import('../src/commands/analyze.js')
const { runReport } = await import('../src/commands/report.js')

/**
 * A client that answers the two request shapes the writing layer sends, taking its
 * evidence from the slice it was given. It is the same idea as
 * `scripts/verify-stub.mjs`, kept here so the sample needs nothing but Node.
 */
function stubClient(): {
  complete: (request: { system: string; user: string }) => Promise<{
    json: unknown
    usage: { in: number; out: number }
  }>
} {
  return {
    async complete({ system, user }) {
      const prompt = `${system}\n${user}`
      const isSynthesis = prompt.includes('"topFive"')
      if (isSynthesis) {
        const titles = user
          .split('\n')
          .map((line) => /^\d+\.\s+(.+)$/.exec(line.trim()))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => match[1] as string)
        return {
          json: { problem: '该仓库的设计决策如下。', topFive: titles.slice(0, 5) },
          usage: { in: 10, out: 10 },
        }
      }
      const slice = /^---\s+(\S+?):(\d+)-(\d+)\s+---$/gm
      let header = slice.exec(user)
      let found: { path: string; line: number; snippet: string } | null = null
      while (header !== null) {
        const [, file, startRaw] = header
        const tail = user.slice(header.index)
        const numbered = /^\s*(\d+)\s*\|\s?(.*)$/gm
        let best: { line: number; snippet: string } | null = null
        let line = numbered.exec(tail)
        while (line !== null) {
          const text = line[2] ?? ''
          if (text.trim() !== '' && (best === null || text.trim().length > best.snippet.trim().length)) {
            best = { line: Number(line[1]), snippet: text }
          }
          line = numbered.exec(tail)
        }
        if (best !== null) {
          found = { path: file as string, line: best.line, snippet: best.snippet }
          break
        }
        header = slice.exec(user)
      }
      if (found === null) return { json: { points: [] }, usage: { in: 10, out: 10 } }
      return {
        json: {
          id: 'sample',
          title: '从引用代码看：这里有一个具体的设计决定',
          kind: 'data-model',
          problem: { constraint: '待模型补全', stakes: '待模型补全' },
          alternatives: [{ approach: '待模型补全', cost: '待模型补全' }],
          theirs: { summary: '待模型补全', evidence: [{ path: found.path, startLine: found.line, endLine: found.line, snippet: found.snippet }] },
          mechanism: '待模型补全',
          tradeoffs: [{ cost: '待模型补全', whenItHurts: '待模型补全' }],
          confidence: 'high',
          unknowns: [],
          recipe: null,
        },
        usage: { in: 10, out: 10 },
      }
    },
  }
}

const outDir = path.join(here, 'quality-sample')
mkdirSync(outDir, { recursive: true })

const requested = process.argv.slice(2)
const files =
  requested.length > 0
    ? requested
    : readdirSync(path.join(here, 'gold'))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(here, 'gold', name))

let produced = 0
for (const file of files) {
  const gold = readGold(JSON.parse(readFileSync(file, 'utf8')))
  if (gold === null) continue
  const slug = path.basename(file, '.json')

  const result = await runAnalyze(gold.repo, {
    model: 'stub',
    ref: gold.sha,
    top: 8,
    baseDir: path.join(outDir, '.runs'),
    apiKey: 'sample',
    client: stubClient(),
  })

  const markdown = await runReport(result.runId, { baseDir: path.join(outDir, '.runs') })
  // The machine's own directory goes into `scope.root` and from there into every
  // sample. These files are committed, so an absolute home path here would ship a
  // username to everyone who clones the repository, and would make the samples
  // specific to one machine for no benefit.
  writeFileSync(path.join(outDir, `${slug}.md`), markdown.replaceAll(here, '<repo-root>'))
  produced += 1
  process.stdout.write(`${slug}: ${markdown.split('\n').length} lines\n`)
}

process.stdout.write(`\nwrote ${produced} reports to ${path.relative(process.cwd(), outDir)}\n`)
