/**
 * `report.md` — the only surface the reader touches.
 *
 * Two promises decide the layout. Every claim shows the citation and the
 * verbatim snippet underneath it, because a reader who cannot check a claim will
 * not believe the next one; and the page ends by naming what it did not look at,
 * because silence about a gap reads as a claim of completeness.
 *
 * The prose comes from a language model, so none of it is trusted as markdown.
 * Titles, mechanism, tradeoffs and recipes are flattened to one line and have
 * their `<`, `>` and backticks neutralised: a title containing `<details>` must
 * not open a block, and a mechanism containing a fence must not swallow the rest
 * of the page. Code is the exception. A snippet is emitted byte for byte, inside
 * a fence one backtick longer than the longest run it contains, so a snippet that
 * itself contains ``` still renders as code.
 *
 * Numbers come from `validation.stats` and `scope.totals` via `buildReport`;
 * this file formats them and never recomputes them.
 */

import type { ReportInput } from '../contracts/types.js'
import type { ReportDocument, ReportPoint } from './json.js'
import { buildReport } from './json.js'

const KIND_LABEL: Record<string, string> = {
  architecture: '架构',
  algorithm: '算法',
  'data-model': '数据模型',
  'api-design': '接口设计',
  performance: '性能',
  testing: '测试',
  tooling: '工具链',
  process: '流程',
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

// --- text safety ----------------------------------------------------------

/**
 * A model-supplied string as one line of prose.
 *
 * Whitespace becomes a single space so a newline cannot start a heading or a
 * block, and `<`/`>` are escaped so they cannot open an HTML block. The text
 * stays readable — `&lt;details&gt;` renders as the characters the model wrote.
 *
 * Backticks are **not** escaped. `\`` renders as a literal backtick, so a model
 * that wrote ``用 `ip|slug` 拼 key`` came out as ``用 \`ip|slug\` 拼 key`` — the
 * backslash leaked into the page. The characters are also harmless here: this
 * output only runs through `prose()` into paragraph text, and a code span needs
 * a closing backtick, so a lone one renders literally anyway. Where a backtick
 * really could break structure — titles, snippets, citations — the code already
 * goes through `codeSpan()`/`fence()`, which size their own delimiters to the
 * content instead of escaping it.
 */
function prose(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function proseOr(value: unknown, fallback: string): string {
  const rendered = prose(value)
  return rendered === '' ? fallback : rendered
}

/**
 * Inline code that survives its own content.
 *
 * A citation is short and nearly always contains no backtick, but a path is
 * untrusted input: one backtick would end the span and let the rest of the path
 * become markdown. The delimiter grows past the longest run, and a leading or
 * trailing backtick gets the padding CommonMark requires.
 */
function inlineCode(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ')
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const ticks = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

function maxBacktickRun(code: string): number {
  let longest = 0
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

/**
 * A fenced block whose delimiter cannot be closed by its own content.
 *
 * The body is concatenated, not split and re-joined, so no byte of the snippet
 * changes — including a trailing newline. A snippet containing ``` simply gets
 * a ```` fence.
 */
function fenced(code: string): string {
  const fence = '`'.repeat(Math.max(3, maxBacktickRun(code) + 1))
  const terminator = code.endsWith('\n') ? '' : '\n'
  return `${fence}\n${code}${terminator}${fence}`
}

// --- numbers --------------------------------------------------------------

/** Stats are copied verbatim by `buildReport`; this only spells them. */
function numberText(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '未知' : String(value)
}

/** A rate is stored as a fraction and shown as a percentage. Not recomputed. */
function percentText(rate: number | undefined): string {
  return rate === undefined || !Number.isFinite(rate) ? '未知' : `${(rate * 100).toFixed(1)}%`
}

// --- sections -------------------------------------------------------------

function brief(doc: ReportDocument): string {
  const lines: string[] = []

  lines.push('## 这次分析在解决什么', '')
  lines.push(proseOr(doc.problem, '这次没有拿到对仓库整体问题的概括。'), '')

  const heading =
    doc.topFive.length === 0 ? '## 最值得学的点' : `## 最值得学的 ${doc.topFive.length} 件事`
  lines.push(heading, '')
  if (doc.topFive.length === 0) {
    lines.push('- 这次没有选出最值得学的条目。')
  } else {
    // A point the page withheld must not be advertised as if it were below:
    // the list stays, but the entry says where it went.
    const rendered = new Set(doc.points.map((point) => prose(point.title)))
    doc.topFive.forEach((item, index) => {
      const shown = prose(item)
      const absent = !rendered.has(shown) ? '（未进正文）' : ''
      lines.push(`${index + 1}. ${shown}${absent}`)
    })
  }
  lines.push('')

  lines.push('## 这次分析的可信度', '')
  lines.push(`- 已取证点占比：${percentText(doc.trust.evidenceRate)}`)
  lines.push(`- 被丢弃证据数：${numberText(doc.trust.droppedEvidence)}`)
  lines.push(`- 每点平均证据数：${numberText(doc.trust.avgEvidence)}`)
  lines.push('')

  lines.push('## 分析口径', '')
  if (doc.source !== '') lines.push(`- 来源：${proseOr(doc.source, '（未知）')}`)
  lines.push(`- 根目录：${proseOr(doc.analysis.root, '（未知）')}`)
  lines.push(
    `- 规模：${numberText(doc.analysis.totals.files)} 个文件 / ` +
      `${numberText(doc.analysis.totals.bytes)} 字节 / ` +
      `${numberText(doc.analysis.totals.lines)} 行`,
  )
  const languages =
    doc.analysis.languages.length === 0
      ? '未识别'
      : doc.analysis.languages
          .map((item) => `${prose(item.language)} ${numberText(item.files)}`)
          .join('、')
  lines.push(`- 语言：${languages}`)
  const excluded =
    doc.analysis.excluded.length === 0
      ? '没有文件被排除'
      : doc.analysis.excluded
          .map((item) => `${prose(item.reason)} ${numberText(item.count)}`)
          .join('、')
  lines.push(`- 排除：${excluded}`)

  return lines.join('\n')
}

function evidenceBlock(point: ReportPoint): string {
  const lines: string[] = []
  for (const item of point.theirs.evidence) {
    const citation = `${item.path}:${item.startLine}-${item.endLine}`
    lines.push(inlineCode(citation), '', fenced(item.snippet), '')
  }
  return lines.join('\n').trimEnd()
}

function recipeBlock(point: ReportPoint): string {
  const recipe = point.recipe
  if (recipe === null) return ''

  const lines: string[] = ['<details>', '<summary>要在自己项目里用</summary>', '']

  lines.push('**前置条件**', '')
  if (recipe.prereqs.length === 0) lines.push('- （没有额外前置条件）')
  else for (const item of recipe.prereqs) lines.push(`- ${prose(item)}`)
  lines.push('')

  lines.push('**最小形态**', '')
  lines.push(
    fenced(recipe.minimalForm.trim() === '' ? '// （没有给出最小形态）' : recipe.minimalForm),
    '',
  )

  lines.push('**什么情况下别用**', '')
  if (recipe.avoidWhen.length === 0) lines.push('- （没有记录适用边界）')
  else for (const item of recipe.avoidWhen) lines.push(`- ${prose(item)}`)

  lines.push('', '</details>')
  return lines.join('\n')
}

function pointSection(point: ReportPoint, index: number): string {
  const lines: string[] = []

  lines.push(`## ${index}. ${proseOr(point.title, '（无标题）')}`, '')
  lines.push(`- 类型：${KIND_LABEL[point.kind] ?? proseOr(point.kind, '未分类')}`)
  lines.push(`- 置信度：${CONFIDENCE_LABEL[point.confidence] ?? proseOr(point.confidence, '未标注')}`)
  lines.push('')

  const stakes = prose(point.problem.stakes)
  const constraint = proseOr(point.problem.constraint, '（没有记录约束）')
  lines.push(`**约束**：${stakes === '' ? constraint : `${constraint}（${stakes}）`}`, '')

  lines.push('**常见做法与代价**', '')
  if (point.alternatives.length === 0) lines.push('- （没有记录常见做法）')
  else {
    for (const item of point.alternatives) {
      const approach = proseOr(item.approach, '（未命名做法）')
      const cost = prose(item.cost)
      lines.push(`- ${cost === '' ? approach : `${approach} —— ${cost}`}`)
    }
  }
  lines.push('')

  lines.push('**他们怎么做**', '', proseOr(point.theirs.summary, '（没有记录做法）'), '')
  const evidence = evidenceBlock(point)
  if (evidence !== '') lines.push(evidence, '')

  lines.push('**为什么有效**', '', proseOr(point.mechanism, '（没有记录原理）'), '')

  lines.push('**代价**', '')
  if (point.tradeoffs.length === 0) lines.push('- （没有记录代价）')
  else {
    for (const item of point.tradeoffs) {
      const cost = proseOr(item.cost, '（未命名代价）')
      const hurts = prose(item.whenItHurts)
      lines.push(`- ${hurts === '' ? cost : `${cost} —— ${hurts}`}`)
    }
  }

  if (point.unknowns.length > 0) {
    lines.push('', '**还不确定的地方**', '')
    for (const item of point.unknowns) lines.push(`- ${prose(item)}`)
  }

  const recipe = recipeBlock(point)
  if (recipe !== '') lines.push('', recipe)

  return lines.join('\n')
}

function emptyState(doc: ReportDocument): string {
  const reasons: string[] = []
  for (const note of doc.notes) reasons.push(`备注：${prose(note)}`)
  for (const skip of doc.skipped) reasons.push(`跳过：${prose(skip)}`)
  for (const item of doc.notRendered) reasons.push(`没有可核对的证据：${prose(item.pointId)}`)
  for (const item of doc.validation.dropped) {
    reasons.push(`被丢弃：${proseOr(item.pointId, '（未知点）')} —— ${prose(item.reason)}`)
  }
  if (reasons.length === 0) {
    reasons.push('这次分析没有留下可用的线索：既没有被跳过的部分，也没有可复述的备注。')
  }

  const lines: string[] = [
    '## 没找到值得学的点',
    '',
    '这次没有找到既能核对到具体代码、又值得学习的点。原因如下：',
    '',
  ]
  for (const reason of reasons) lines.push(`- ${reason}`)
  return lines.join('\n')
}

function tail(doc: ReportDocument): string {
  const outside: string[] = []
  for (const skip of doc.skipped) outside.push(`- 跳过：${prose(skip)}`)
  for (const note of doc.notes) outside.push(`- 备注：${prose(note)}`)

  const withheld: string[] = [
    `- 没有可核对证据的点：${doc.notRendered.length} 个`,
    `- 被降级的点：${doc.validation.downgraded.length} 个`,
    `- 被丢弃的点：${doc.validation.dropped.length} 个`,
  ]
  for (const item of doc.validation.dropped) {
    withheld.push(`- 丢弃原因：${proseOr(item.pointId, '（未知点）')} —— ${prose(item.reason)}`)
  }
  for (const item of doc.validation.downgraded) {
    withheld.push(`- 降级原因：${proseOr(item.pointId, '（未知点）')} —— ${prose(item.reason)}`)
  }

  const declared =
    doc.skipped.length > 0 ||
    doc.notes.length > 0 ||
    doc.notRendered.length > 0 ||
    doc.validation.dropped.length > 0 ||
    doc.validation.downgraded.length > 0

  if (!declared) return ['## 没看的部分', '', '- 没有需要声明的遗漏。'].join('\n')

  const lines: string[] = ['## 没看的部分', '', '**分析口径之外**', '']
  if (outside.length === 0) lines.push('- （没有声明被跳过的输入）')
  else lines.push(...outside)

  lines.push('', '**没进正文的判断**', '')
  lines.push(...withheld)
  return lines.join('\n')
}

/**
 * The whole page.
 *
 * An empty `points` array still produces a complete report: the brief, the
 * numbers and the coverage tail stay, and the missing middle is explained from
 * the profile notes and the skip list rather than left blank.
 */
export function renderMarkdown(input: ReportInput): string {
  const doc = buildReport(input)
  const sections: string[] = [`# ${proseOr(doc.repo, '未知仓库')}`, brief(doc)]

  if (doc.points.length === 0) {
    sections.push(emptyState(doc))
  } else {
    doc.points.forEach((point, index) => sections.push(pointSection(point, index + 1)))
  }

  sections.push(tail(doc))
  return `${sections.join('\n\n')}\n`
}
