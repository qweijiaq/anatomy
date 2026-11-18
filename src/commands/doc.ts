/**
 * `ana doc <runId>` — turn a verified report into a repository document.
 *
 * A report is read once; an architecture note is read by the next person who opens
 * the repository. The difference is not prose, it is shape: a reading order, a
 * structure diagram derived from the index, and a bundle that travels without the
 * run directory.
 *
 * Only points whose evidence survived validation reach this document, and every
 * section keeps its `path:start-end` citation. The bundle includes the evidence
 * snippets so a reader can check a claim offline; it never re-asks a model.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { LearningPoint, ReportInput, StructureIndex } from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { readManifest, isArtifactName } from '../store/runs.js'
import { readReportInput } from './report.js'
import { runReport } from './report.js'
import type { Lang } from '../render/labels.js'

export const DOC_USAGE = `Usage: ana doc <runId> [options]

Options:
  --out <file>       Write the document to this path (default: stdout)
  --bundle <dir>     Also write a portable bundle: doc, report, diagram and evidence
  --dir <path>       Look in this run directory instead of .ana/runs`

export type DocOptions = {
  baseDir?: string
  out?: string
  bundle?: string
}

export type DocArgs =
  | { help: true }
  | { help: false; runId: string; options: DocOptions }

export class DocUsageError extends Error {}

export function parseDocArgs(argv: string[]): DocArgs {
  const positional: string[] = []
  const options: DocOptions = {}
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
      let value: string
      if (equals !== -1) value = token.slice(equals + 1)
      else {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) throw new DocUsageError(`--${name} needs a value`)
        value = next
        index += 1
      }
      if (value === '') throw new DocUsageError(`--${name} needs a value`)
      if (name === 'out') options.out = path.resolve(value)
      else if (name === 'bundle') options.bundle = path.resolve(value)
      else if (name === 'dir') options.baseDir = path.resolve(value)
      else throw new DocUsageError(`unknown option "--${name}"`)
      continue
    }
    positional.push(token)
  }
  if (help) return { help: true }
  const [runId, ...rest] = positional
  if (runId === undefined) throw new DocUsageError('doc needs a run id')
  if (rest.length > 0) throw new DocUsageError(`unexpected argument "${rest[0]}"`)
  return { help: false, runId, options }
}

function repoName(input: ReportInput): string {
  const cleaned = input.source.replace(/[/\\]+$/, '')
  const segment = cleaned.slice(Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\')) + 1)
  return segment === '' ? 'repository' : segment
}

function cite(evidence: { path: string; startLine: number; endLine: number }): string {
  return `\`${evidence.path}:${evidence.startLine}-${evidence.endLine}\``
}

/** The first citation of a point, for the reading path. */
function firstCite(point: LearningPoint): string {
  const evidence = point.theirs.evidence[0]
  return evidence === undefined ? '' : cite(evidence)
}

/**
 * A diagram of the module graph, bounded and derived.
 *
 * Only the modules with the most edges are drawn; the full graph of a large
 * repository is a hairball, and a diagram that cannot be read is worse than none.
 * Unresolved imports are not drawn — the graph shows what the index knows, not
 * what it guessed.
 */
export function diagramOf(structure: StructureIndex | undefined): string {
  if (structure === undefined || structure.modules.length === 0) return ''
  const degree = new Map<string, number>()
  for (const module of structure.modules) {
    degree.set(module.path, (degree.get(module.path) ?? 0) + module.imports.length)
    for (const edge of module.imports) {
      if (edge.resolved !== null) degree.set(edge.resolved, (degree.get(edge.resolved) ?? 0) + 1)
    }
  }
  const chosen = [...degree.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([path]) => path)
  if (chosen.length === 0) return ''
  const index = new Map(chosen.map((item, position) => [item, position]))
  const id = (item: string): string => `n${index.get(item) ?? 0}`
  const label = (item: string): string => item.replace(/["\\\n]/g, ' ').slice(-48)
  const lines = ['flowchart LR']
  for (const item of chosen) lines.push(`  ${id(item)}["${label(item)}"]`)
  for (const module of structure.modules) {
    if (!index.has(module.path)) continue
    for (const edge of module.imports) {
      if (edge.resolved === null || !index.has(edge.resolved)) continue
      lines.push(`  ${id(module.path)} --> ${id(edge.resolved)}`)
    }
  }
  return lines.join('\n')
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$/

/**
 * Test files that mention a cited file, statically.
 *
 * This is a lexical hint, not a coverage claim: it reads test-like files from the
 * checkout and looks for the source basename. The document says so next to the
 * list, because "a test mentions this file" and "this behaviour is covered" are
 * different claims, and only the first one is checkable here.
 */
async function testLinks(
  root: string,
  files: Array<{ path: string }>,
  points: LearningPoint[],
): Promise<Map<string, string[]>> {
  const candidates = files.filter((file) => TEST_PATH.test(file.path)).slice(0, 40)
  const texts: string[] = []
  for (const file of candidates) {
    try {
      texts.push(`${file.path}\n${await readFile(path.join(root, file.path), 'utf8')}`)
    } catch {
      // A test file that vanished is not a failed document.
    }
  }
  const links = new Map<string, string[]>()
  for (const point of points) {
    const found = new Set<string>()
    for (const evidence of point.theirs.evidence) {
      const stem = path.basename(evidence.path).replace(/\.[^.]+$/, '')
      if (stem.length < 4) continue
      for (const text of texts) {
        const first = text.indexOf('\n')
        const file = text.slice(0, first)
        const body = text.slice(first + 1)
        if (body.includes(evidence.path) || body.includes(stem)) found.add(file)
      }
    }
    if (found.size > 0) links.set(point.id, [...found].slice(0, 8))
  }
  return links
}

function pointSection(
  point: LearningPoint,
  index: number,
  lang: Lang,
  tests: string[] = [],
): string {
  const labels =
    lang === 'en'
      ? {
          constraint: 'Constraint',
          approach: 'What they did',
          mechanism: 'Mechanism',
          tradeoffs: 'What it costs',
          evidence: 'Evidence',
        }
      : { constraint: '约束', approach: '做法', mechanism: '机制', tradeoffs: '代价', evidence: '证据' }
  const lines = [`## ${index + 1}. ${point.title}`, '']
  lines.push(`**${labels.constraint}**：${point.problem.constraint}`, '')
  lines.push(`**${labels.approach}**：${point.theirs.summary}`, '')
  lines.push(`**${labels.mechanism}**：${point.mechanism}`, '')
  if (point.tradeoffs.length > 0) {
    lines.push(`**${labels.tradeoffs}**`, '')
    for (const item of point.tradeoffs) lines.push(`- ${item.cost} —— ${item.whenItHurts}`)
    lines.push('')
  }
  lines.push(`**${labels.evidence}**`, '')
  for (const evidence of point.theirs.evidence) lines.push(`- ${cite(evidence)}`)
  if (tests.length > 0) {
    lines.push('', lang === 'en' ? '**Tests that mention it** (lexical, not coverage)' : '**提到它的测试**（静态匹配，不是覆盖率）', '')
    for (const test of tests) lines.push(`- \`${test}\``)
  }
  return lines.join('\n')
}

export type DocResult = {
  markdown: string
  diagram: string
  evidence: Array<{ title: string; path: string; startLine: number; endLine: number; snippet: string }>
}

/** Renders the document; no file is written here, so it is testable as a string. */
export async function buildDoc(runId: string, opts: DocOptions = {}): Promise<DocResult> {
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  if (!isArtifactName(runId)) throw new DocUsageError(`"${runId}" is not a run id`)
  const input = await readReportInput(runId, { baseDir })
  const manifest = await readManifest(baseDir, runId)
  const lang: Lang = input.lang ?? 'zh'
  const name = repoName(input)
  const L =
    lang === 'en'
      ? {
          title: `${name} — architecture notes`,
          provenance: `Generated by anatomy from run \`${runId}\`${manifest?.sha === undefined ? '' : ` at \`${manifest.sha.slice(0, 7)}\``}. Every claim cites \`path:start-end\`; check one with \`ana inspect\`.`,
          problem: 'What this repository is',
          path: 'Reading order',
          diagram: 'Structure',
          notCovered: 'What was not covered',
          points: 'Design decisions',
        }
      : {
          title: `${name} — 架构笔记`,
          provenance: `由 anatomy 从 run \`${runId}\`${manifest?.sha === undefined ? '' : `（提交 \`${manifest.sha.slice(0, 7)}\`）`}生成。每条主张都带 \`path:起止行\`，可用 \`ana inspect\` 核对。`,
          problem: '这个仓库在解决什么',
          path: '阅读顺序',
          diagram: '结构',
          notCovered: '没看的部分',
          points: '设计决定',
        }

  const rendered = input.points
  const order =
    input.topFive.length > 0
      ? input.topFive
          .map((title) => rendered.find((point) => point.title === title))
          .filter((point): point is LearningPoint => point !== undefined)
      : rendered
  const readings = order.map((point, index) => {
    const where = firstCite(point)
    return `${index + 1}. **${point.title}**${where === '' ? '' : ` —— ${where}`}`
  })

  const diagram = diagramOf(input.structure)
  let tests = new Map<string, string[]>()
  try {
    const info = await stat(input.source)
    if (info.isDirectory()) tests = await testLinks(input.source, input.scope.files, rendered)
  } catch {
    // A URL or a deleted checkout has no tests to read; the section is omitted.
  }
  const sections: string[] = [
    `# ${L.title}`,
    `> ${L.provenance}`,
    `## ${L.problem}`,
    input.problem === '' ? '—' : input.problem,
  ]
  if (readings.length > 0) sections.push(`## ${L.path}`, readings.join('\n'))
  if (rendered.length > 0) {
    sections.push(`## ${L.points}`)
    rendered.forEach((point, index) =>
      sections.push(pointSection(point, index, lang, tests.get(point.id) ?? [])),
    )
  }
  if (diagram !== '') sections.push(`## ${L.diagram}`, '```mermaid', diagram, '```')
  if (input.skipped.length > 0) {
    sections.push(`## ${L.notCovered}`, input.skipped.map((line) => `- ${line}`).join('\n'))
  }

  const evidence = rendered.flatMap((point) =>
    point.theirs.evidence.map((item) => ({
      title: point.title,
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      snippet: item.snippet,
    })),
  )
  return { markdown: `${sections.join('\n\n')}\n`, diagram, evidence }
}

/**
 * Writes the document, and optionally a bundle that still makes sense without the
 * run directory: the report, the diagram, the evidence snippets and a note saying
 * where they came from.
 */
export async function runDoc(
  runId: string,
  opts: DocOptions = {},
  io: { out: { write(chunk: string): unknown } } = { out: process.stdout },
): Promise<DocResult> {
  const result = await buildDoc(runId, opts)
  if (opts.out !== undefined) {
    await mkdir(path.dirname(opts.out), { recursive: true })
    await writeFile(opts.out, result.markdown, 'utf8')
  } else {
    io.out.write(result.markdown)
  }

  if (opts.bundle !== undefined) {
    await mkdir(opts.bundle, { recursive: true })
    await writeFile(path.join(opts.bundle, 'ARCHITECTURE.md'), result.markdown, 'utf8')
    if (result.diagram !== '') await writeFile(path.join(opts.bundle, 'diagram.mmd'), `${result.diagram}\n`, 'utf8')
    const report = await runReport(runId, {
      ...(opts.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    })
    await writeFile(path.join(opts.bundle, 'report.md'), report, 'utf8')
    await writeFile(
      path.join(opts.bundle, 'evidence.json'),
      `${JSON.stringify(result.evidence, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      path.join(opts.bundle, 'README.txt'),
      [
        'This bundle was generated by anatomy from one stored analysis.',
        '',
        `run: ${runId}`,
        'report.md is the original evidence-backed report.',
        'ARCHITECTURE.md is the repository-facing document.',
        'diagram.mmd is a Mermaid module graph.',
        'evidence.json holds the stored snippets cited by the document.',
        '',
        'Nothing here calls a model. Re-generate with:',
        `  ana doc ${runId} --out ARCHITECTURE.md`,
      ].join('\n'),
      'utf8',
    )
  }
  return result
}
