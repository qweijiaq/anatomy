/**
 * `ana export <runId>` — one paid analysis, a dossier of outputs.
 *
 * The expensive part of a run is judging candidates; the report spends that work
 * once. Everything here is rendered from artifacts already on disk, so the marginal
 * model cost is zero. `--enrich` is the single exception, and it is explicit: one
 * batched call for a glossary and an FAQ, with the same citation rule as `ask`.
 *
 * Every deterministic file either cites a stored range or says it is derived aid
 * (a quiz, a review question). Padding a bundle with unsupported prose would make
 * the token saving look like a bargain and the document worthless.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Candidate, LearningPoint, ReportInput } from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { isArtifactName, readManifest } from '../store/runs.js'
import type { ModelClient } from '../writing/client.js'
import type { Lang } from '../render/labels.js'
import { buildDoc, diagramOf } from './doc.js'
import { readReportInput, runReport } from './report.js'
import { enrichDossier, type Enrichment } from '../writing/enrich.js'

export type ExportOptions = {
  baseDir?: string
  out?: string
  enrich?: boolean
  client?: ModelClient
  model?: string
  apiKey?: string
}

export type ExportResult = {
  dir: string
  files: string[]
  modelCalls: number
  /** Set when `--enrich` was requested but produced nothing usable. */
  enrichError?: string
}

export class ExportUsageError extends Error {}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function cell(value: string): string {
  return oneLine(value).replace(/\|/g, '\\|')
}

function cite(evidence: { path: string; startLine: number; endLine: number }): string {
  return `\`${evidence.path}:${evidence.startLine}-${evidence.endLine}\``
}

function firstCite(point: LearningPoint): string {
  const evidence = point.theirs.evidence[0]
  return evidence === undefined ? '—' : cite(evidence)
}

function ordered(input: ReportInput): LearningPoint[] {
  if (input.topFive.length === 0) return input.points
  const wanted = input.topFive
    .map((title) => input.points.find((point) => point.title === title))
    .filter((point): point is LearningPoint => point !== undefined)
  return wanted.length > 0 ? wanted : input.points
}

function sourceName(input: ReportInput): string {
  const cleaned = input.source.replace(/[/\\]+$/, '')
  const segment = cleaned.slice(Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\')) + 1)
  return segment === '' ? 'repository' : segment
}

function headings(lang: Lang): Record<string, string> {
  return lang === 'en'
    ? {
        index: 'What is in this bundle',
        summary: 'One-page summary',
        architecture: 'Architecture notes',
        decisions: 'Decision matrix',
        risks: 'Costs, unknowns, and signals',
        onboarding: 'Starting here',
        hotspots: 'Where the candidates were',
        quiz: 'Self-check',
        glossary: 'Glossary',
        faq: 'Questions this report can answer',
        provenance: 'Provenance',
        cost: 'What this cost',
      }
    : {
        index: '这个包里有什么',
        summary: '一页摘要',
        architecture: '架构笔记',
        decisions: '决策矩阵',
        risks: '代价、未知与信号',
        onboarding: '从这里开始',
        hotspots: '候选分布',
        quiz: '自测',
        glossary: '术语表',
        faq: '这份报告能回答的问题',
        provenance: '来源',
        cost: '成本',
      }
}

function summaryDoc(input: ReportInput, lang: Lang): string {
  const L = headings(lang)
  const points = ordered(input)
  const lines = [`# ${sourceName(input)} — ${L.summary}`, '', input.problem || '—', '']
  lines.push(`## ${lang === 'en' ? 'The decisions worth knowing' : '值得知道的决定'}`, '')
  points.slice(0, 5).forEach((point, index) => {
    lines.push(`${index + 1}. **${point.title}** — ${oneLine(point.theirs.summary)} ${firstCite(point)}`)
  })
  const costs = points.flatMap((point) => point.tradeoffs.map((item) => `- ${cell(item.cost)} —— ${cell(item.whenItHurts)} ${firstCite(point)}`))
  if (costs.length > 0) lines.push('', `## ${lang === 'en' ? 'What it costs' : '代价'}`, '', ...costs)
  return `${lines.join('\n')}\n`
}

function decisionsDoc(input: ReportInput, lang: Lang): string {
  const L = headings(lang)
  const head =
    lang === 'en'
      ? '| Decision | Constraint | Alternatives | Cost | When it hurts | Confidence | Evidence |'
      : '| 决定 | 约束 | 替代方案 | 代价 | 什么时候会疼 | 置信度 | 证据 |'
  const lines = [`# ${L.decisions}`, '', head, '| --- | --- | --- | --- | --- | --- | --- |']
  for (const point of ordered(input)) {
    const alternatives =
      point.alternatives.length === 0
        ? '—'
        : point.alternatives.map((item) => `${item.approach}（${item.cost}）`).join('；')
    for (const [index, tradeoff] of point.tradeoffs.entries()) {
      lines.push(
        `| ${index === 0 ? cell(point.title) : ''} | ${index === 0 ? cell(point.problem.constraint) : ''} | ${index === 0 ? cell(alternatives) : ''} | ${cell(tradeoff.cost)} | ${cell(tradeoff.whenItHurts)} | ${index === 0 ? point.confidence : ''} | ${firstCite(point)} |`,
      )
    }
    if (point.tradeoffs.length === 0) {
      lines.push(
        `| ${cell(point.title)} | ${cell(point.problem.constraint)} | ${cell(alternatives)} | — | — | ${point.confidence} | ${firstCite(point)} |`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

function risksDoc(input: ReportInput, lang: Lang): string {
  const L = headings(lang)
  const lines = [
    `# ${L.risks}`,
    '',
    lang === 'en'
      ? 'This is not a vulnerability scan. It collects the costs and unknowns the analysis already stated, plus the security/resilience/data-integrity signals the kernel saw. A signal is a shape, not a finding.'
      : '这不是漏洞扫描。它只整理分析已经写下的代价与未知，以及内核看到的安全/韧性/数据完整性信号。信号是形状，不是结论。',
    '',
    `## ${lang === 'en' ? 'Costs' : '代价'}`,
    '',
  ]
  for (const point of ordered(input)) {
    for (const tradeoff of point.tradeoffs) {
      lines.push(`- **${cell(tradeoff.cost)}** —— ${cell(tradeoff.whenItHurts)} ${firstCite(point)}`)
    }
  }
  const signals = (input.candidates ?? []).filter((candidate) =>
    ['security', 'resilience', 'data-integrity'].includes(candidate.kind),
  )
  if (signals.length > 0) {
    lines.push('', `## ${lang === 'en' ? 'Signals to look at' : '值得看的信号'}`, '')
    for (const signal of signals.slice(0, 20)) {
      lines.push(`- \`${signal.path}:${signal.line}\` · ${signal.kind} · ${signal.matched.join(', ')}`)
    }
  }
  const unknowns = ordered(input).filter((point) => point.unknowns.length > 0)
  if (unknowns.length > 0) {
    lines.push('', `## ${lang === 'en' ? 'Still unknown' : '还不知道'}`, '')
    for (const point of unknowns) {
      lines.push(`- **${point.title}**：${point.unknowns.map(cell).join('；')} ${firstCite(point)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function onboardingDoc(input: ReportInput, lang: Lang): string {
  const L = headings(lang)
  const points = ordered(input)
  const dirs = new Map<string, number>()
  for (const file of input.scope.files) {
    // Tooling and docs are not where the code sits; a `.github/` row in a
    // "where to start" list sends the reader to the wrong place.
    if (file.language === null) continue
    const dir = path.posix.dirname(file.path)
    if (dir === '.' || dir.startsWith('..')) continue
    const top = dir.split('/')[0] as string
    dirs.set(top, (dirs.get(top) ?? 0) + 1)
  }
  const topDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const lines = [`# ${L.onboarding}`, '']
  lines.push(lang === 'en' ? '## Read in this order' : '## 按这个顺序读', '')
  points.forEach((point, index) => {
    lines.push(`${index + 1}. **${point.title}** — ${firstCite(point)}`)
  })
  if (topDirs.length > 0) {
    lines.push('', lang === 'en' ? '## Where the code sits' : '## 代码集中在哪', '')
    for (const [dir, count] of topDirs) lines.push(`- \`${dir}/\` · ${count} files`)
  }
  lines.push('', lang === 'en' ? '## Tests and build' : '## 测试与构建', '')
  lines.push(`- ${lang === 'en' ? 'Manifests' : '清单文件'}：${input.profile.manifests.length > 0 ? input.profile.manifests.map((item) => `\`${item}\``).join('、') : '—'}`)
  lines.push(`- ${lang === 'en' ? 'Tests' : '测试'}：${input.profile.hasTests ? (lang === 'en' ? 'present' : '有') : lang === 'en' ? 'not found' : '未发现'}；CI：${input.profile.hasCi ? (lang === 'en' ? 'present' : '有') : lang === 'en' ? 'not found' : '未发现'}`)
  if (input.profile.entryPoints.length > 0) {
    lines.push(`- ${lang === 'en' ? 'Entry points' : '入口'}：${input.profile.entryPoints.map((item) => `\`${item}\``).join('、')}`)
  }
  lines.push('', lang === 'en' ? 'The commands themselves live in those manifests; the analysis does not execute the repository.' : '具体命令在那个清单文件里；分析没有执行这个仓库。')
  return `${lines.join('\n')}\n`
}

function hotspotsDoc(input: ReportInput, lang: Lang): string {
  const L = headings(lang)
  const candidates = input.candidates ?? []
  const lines = [
    `# ${L.hotspots}`,
    '',
    lang === 'en'
      ? `Coverage: ${input.scope.totals.files} files, ${input.scope.totals.lines} lines. Scores are rule hits, not quality.`
      : `覆盖：${input.scope.totals.files} 个文件、${input.scope.totals.lines} 行。分数是规则命中累加，不是质量评分。`,
    '',
  ]
  if (candidates.length > 0) {
    lines.push(lang === 'en' ? '| Location | Kind | Score | Matched |' : '| 位置 | 类型 | 分 | 命中 |', '| --- | --- | --- | --- |')
    for (const candidate of candidates.slice(0, 30)) {
      lines.push(`| \`${candidate.path}:${candidate.line}\` | ${candidate.kind} | ${candidate.score} | ${cell(candidate.matched.join(', '))} |`)
    }
  }
  if (input.scope.excluded.length > 0) {
    lines.push('', lang === 'en' ? '### Not read' : '### 没读的', '')
    for (const item of input.scope.excluded) lines.push(`- ${item.reason}: ${item.count}`)
  }
  const diagram = diagramOf(input.structure)
  if (diagram !== '') lines.push('', '```mermaid', diagram, '```')
  return `${lines.join('\n')}\n`
}

function quizDoc(input: ReportInput, lang: Lang): string {
  const L = headings(lang)
  const lines = [
    `# ${L.quiz}`,
    '',
    lang === 'en'
      ? 'These questions are generated from the stored points; the answers are the points themselves, with citations. They are a study aid, not new claims.'
      : '这些题由已存的学习点生成，答案是学习点本身，并带引用。它们是自测辅助，不是新的主张。',
    '',
  ]
  const points = ordered(input)
  points.forEach((point, index) => {
    lines.push(`## ${index + 1}. ${point.title}`, '')
    lines.push(lang === 'en' ? '1. What constraint led to this decision?' : '1. 是什么约束导致了这个决定？')
    lines.push(lang === 'en' ? '2. What does it cost, and when does that hurt?' : '2. 它的代价是什么，什么时候会疼？')
    if (point.alternatives.length > 0) lines.push(lang === 'en' ? '3. What was the alternative?' : '3. 当时没有选什么？')
    lines.push('', '<details>', `<summary>${lang === 'en' ? 'Answers' : '答案'}</summary>`, '')
    lines.push(lang === 'en' ? `- Constraint: ${point.problem.constraint} ${firstCite(point)}` : `- 约束：${point.problem.constraint} ${firstCite(point)}`)
    if (point.tradeoffs.length > 0) {
      lines.push(`- ${lang === 'en' ? 'Cost' : '代价'}：${point.tradeoffs.map((item) => `${item.cost} —— ${item.whenItHurts}`).join('；')} ${firstCite(point)}`)
    }
    if (point.alternatives.length > 0) {
      lines.push(`- ${lang === 'en' ? 'Alternative' : '替代'}：${point.alternatives.map((item) => `${item.approach}（${item.cost}）`).join('；')}`)
    }
    lines.push('', '</details>', '')
  })
  return `${lines.join('\n')}\n`
}

function readmeDoc(input: ReportInput, result: { files: string[]; modelCalls: number; enrich: boolean }, lang: Lang): string {
  const L = headings(lang)
  const lines = [
    `# ${sourceName(input)} — anatomy dossier`,
    '',
    lang === 'en'
      ? 'One analysis produced this bundle. The report and every deterministic file reuse the same stored evidence; only `--enrich` spends another model call.'
      : '一次分析生成了这个包。报告和所有确定性文件复用同一批已存证据；只有 `--enrich` 会再花一次模型调用。',
    '',
    `## ${L.cost}`,
    '',
    `- ${lang === 'en' ? 'This bundle' : '这次打包'}：${result.modelCalls} ${lang === 'en' ? 'extra model call(s)' : '次额外模型调用'}`,
    `- ${lang === 'en' ? 'Report' : '报告'}：${input.points.length} ${lang === 'en' ? 'verified points' : '个已取证点'}，${input.skipped.length} ${lang === 'en' ? 'recorded gaps' : '条记录的缺口'}`,
    '',
    `## ${L.index}`,
    '',
  ]
  for (const file of result.files) {
    lines.push(`- \`${file}\``)
  }
  lines.push('', `## ${L.provenance}`, '')
  lines.push(`- source: ${input.source}`)
  lines.push(`- lang: ${input.lang ?? 'zh'}`)
  lines.push(`- generated: ${new Date().toISOString()}`)
  return `${lines.join('\n')}\n`
}

function evidenceJson(input: ReportInput): string {
  const rows = input.points.flatMap((point) =>
    point.theirs.evidence.map((item) => ({
      title: point.title,
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      snippet: item.snippet,
    })),
  )
  return `${JSON.stringify(rows, null, 2)}\n`
}

export async function exportDossier(
  runId: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  if (!isArtifactName(runId)) throw new ExportUsageError(`"${runId}" is not a run id`)
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  const input = await readReportInput(runId, { baseDir })
  const manifest = await readManifest(baseDir, runId)
  const lang: Lang = input.lang ?? 'zh'
  const dir = path.resolve(opts.out ?? path.join(baseDir, '..', 'exports', runId))
  await mkdir(dir, { recursive: true })

  let enrichment: Enrichment | null = null
  let enrichError = ''
  let modelCalls = 0
  if (opts.enrich === true) {
    try {
      enrichment = await enrichDossier({
        input,
        lang,
        ...(opts.client === undefined ? {} : { client: opts.client }),
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }),
      })
      modelCalls = 1
    } catch (error) {
      enrichError = error instanceof Error ? error.message : String(error)
    }
  }

  const doc = await buildDoc(runId, { baseDir })
  const files: Record<string, string> = {
    'SUMMARY.md': summaryDoc(input, lang),
    'ARCHITECTURE.md': doc.markdown,
    'DECISIONS.md': decisionsDoc(input, lang),
    'RISKS.md': risksDoc(input, lang),
    'ONBOARDING.md': onboardingDoc(input, lang),
    'HOTSPOTS.md': hotspotsDoc(input, lang),
    'QUIZ.md': quizDoc(input, lang),
    'evidence.json': evidenceJson(input),
    'report.md': await runReport(runId, { baseDir }),
  }
  if (doc.diagram !== '') files['diagram.mmd'] = `${doc.diagram}\n`
  if (enrichment !== null) {
    files['GLOSSARY.md'] = enrichment.glossary
    files['FAQ.md'] = enrichment.faq
  }
  const names = [...Object.keys(files), 'README.md', 'manifest.json']
  files['README.md'] = readmeDoc(input, { files: names, modelCalls, enrich: opts.enrich === true }, lang)
  files['manifest.json'] = `${JSON.stringify(
    {
      runId,
      source: input.source,
      sha: manifest?.sha ?? '',
      generatedAt: new Date().toISOString(),
      modelCalls,
      enrichRequested: opts.enrich === true,
      ...(enrichError === '' ? {} : { enrichError }),
      files: names,
    },
    null,
    2,
  )}\n`

  // An export without enrichment must not inherit the previous run's glossary.
  for (const name of ['GLOSSARY.md', 'FAQ.md', 'diagram.mmd']) {
    if (!(name in files)) await rm(path.join(dir, name), { force: true })
  }
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, name), contents, 'utf8')
  }
  return {
    dir,
    files: Object.keys(files).sort(),
    modelCalls,
    ...(enrichError === '' ? {} : { enrichError }),
  }
}

export const EXPORT_USAGE = `Usage: ana export <runId> [options]

Options:
  --out <dir>        Bundle directory (default: .ana/exports/<runId>)
  --enrich           Add a glossary and FAQ with one batched model call
  --model <name>     Model for --enrich
  --api-key <key>    Overrides $ANA_API_KEY
  --json             Print the result as JSON
  --dir <path>       Look in this run directory instead of .ana/runs`

export type ExportArgs =
  | { help: true }
  | { help: false; runId: string; json: boolean; options: ExportOptions }

export class ExportArgsError extends Error {}

export function parseExportArgs(argv: string[]): ExportArgs {
  const positional: string[] = []
  const options: ExportOptions = {}
  let json = false
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token === '--json') {
      json = true
      continue
    }
    if (token === '--enrich') {
      options.enrich = true
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
      let value: string
      if (equals !== -1) value = token.slice(equals + 1)
      else {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
          throw new ExportArgsError(`--${name} needs a value`)
        }
        value = next
        index += 1
      }
      if (value === '') throw new ExportArgsError(`--${name} needs a value`)
      if (name === 'out') options.out = path.resolve(value)
      else if (name === 'dir') options.baseDir = path.resolve(value)
      else if (name === 'model') options.model = value
      else if (name === 'api-key') options.apiKey = value
      else throw new ExportArgsError(`unknown option "--${name}"`)
      continue
    }
    positional.push(token)
  }
  if (help) return { help: true }
  const [runId, ...rest] = positional
  if (runId === undefined) throw new ExportArgsError('export needs a run id')
  if (rest.length > 0) throw new ExportArgsError(`unexpected argument "${rest[0]}"`)
  return { help: false, runId, json, options }
}

/** One line for the terminal; JSON is the machine form. */
export function formatExport(result: ExportResult): string {
  const lines = [`wrote ${result.files.length} file(s) to ${result.dir}`, `extra model calls: ${result.modelCalls}`]
  if (result.enrichError !== undefined) lines.push(`enrichment failed: ${result.enrichError}`)
  return `${lines.join('\n')}\n`
}
