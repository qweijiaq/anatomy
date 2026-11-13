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

import type { ReportInput, SymbolRef } from '../contracts/types.js'
import { labelsFor, type Labels, type Lang } from './labels.js'
import type { ReportDocument, ReportPoint } from './json.js'
import { buildReport } from './json.js'



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
 * goes through `inlineCode()`/`fence()`, which size their own delimiters to the
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
function numberText(value: number | undefined, L: Labels): string {
  return value === undefined || !Number.isFinite(value) ? L.unknown : String(value)
}

/** A rate is stored as a fraction and shown as a percentage. Not recomputed. */
function percentText(rate: number | undefined, L: Labels): string {
  return rate === undefined || !Number.isFinite(rate) ? L.unknown : `${(rate * 100).toFixed(1)}%`
}

// --- sections -------------------------------------------------------------

function brief(doc: ReportDocument, L: Labels): string {
  const lines: string[] = []

  lines.push(`## ${L.problemHeading}`, '')
  lines.push(proseOr(doc.problem, L.problemFallback), '')

  const heading =
    doc.topFive.length === 0 ? `## ${L.topHeadingEmpty}` : `## ${L.topHeading(doc.topFive.length)}`
  lines.push(heading, '')
  if (doc.topFive.length === 0) {
    lines.push(`- ${L.topEmpty}`)
  } else {
    // A point the page withheld must not be advertised as if it were below:
    // the list stays, but the entry says where it went.
    const rendered = new Set(doc.points.map((point) => prose(point.title)))
    doc.topFive.forEach((item, index) => {
      const shown = prose(item)
      const absent = !rendered.has(shown) ? L.notInBody : ''
      lines.push(`${index + 1}. ${shown}${absent}`)
    })
  }
  lines.push('')

  lines.push(`## ${L.trustHeading}`, '')
  lines.push(`- ${L.evidenceRate}${L.colon}${percentText(doc.trust.evidenceRate, L)}`)
  lines.push(`- ${L.droppedEvidence}${L.colon}${numberText(doc.trust.droppedEvidence, L)}`)
  lines.push(`- ${L.avgEvidence}${L.colon}${numberText(doc.trust.avgEvidence, L)}`)
  lines.push('')

  lines.push(`## ${L.scopeHeading}`, '')
  if (doc.source !== '') lines.push(`- ${L.source}${L.colon}${proseOr(doc.source, L.unknown)}`)
  lines.push(`- ${L.root}${L.colon}${proseOr(doc.analysis.root, L.unknown)}`)
  lines.push(
    `- ${L.scaleLabel}${L.colon}${L.scale(
      numberText(doc.analysis.totals.files, L),
      numberText(doc.analysis.totals.bytes, L),
      numberText(doc.analysis.totals.lines, L),
    )}`,
  )
  const languages =
    doc.analysis.languages.length === 0
      ? L.unidentified
      : doc.analysis.languages
          .map((item) => `${prose(item.language)} ${numberText(item.files, L)}`)
          .join(L.listSeparator)
  lines.push(`- ${L.languages}${L.colon}${languages}`)
  const excluded =
    doc.analysis.excluded.length === 0
      ? L.nothingExcluded
      : doc.analysis.excluded
          .map((item) => `${prose(item.reason)} ${numberText(item.count, L)}`)
          .join(L.listSeparator)
  lines.push(`- ${L.excluded}${L.colon}${excluded}`)

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

function recipeBlock(point: ReportPoint, L: Labels): string {
  const recipe = point.recipe
  if (recipe === null) return ''

  // `<summary>` is rendered as a real tag by the in-window parser, so this text is
  // part of the page's structure rather than prose — which is why it belongs here.
  const lines: string[] = ['<details>', `<summary>${L.recipeSummary}</summary>`, '']

  lines.push(`**${L.prereqs}**`, '')
  if (recipe.prereqs.length === 0) lines.push(`- ${L.noPrereqs}`)
  else for (const item of recipe.prereqs) lines.push(`- ${prose(item)}`)
  lines.push('')

  lines.push(`**${L.minimalForm}**`, '')
  lines.push(
    fenced(recipe.minimalForm.trim() === '' ? L.noMinimalForm : recipe.minimalForm),
    '',
  )

  lines.push(`**${L.avoidWhen}**`, '')
  if (recipe.avoidWhen.length === 0) lines.push(`- ${L.noAvoidWhen}`)
  else for (const item of recipe.avoidWhen) lines.push(`- ${prose(item)}`)

  lines.push('', '</details>')
  return lines.join('\n')
}

function pointSection(point: ReportPoint, index: number, L: Labels): string {
  const lines: string[] = []

  lines.push(`## ${index}. ${proseOr(point.title, L.untitled)}`, '')
  lines.push(`- ${L.kind}${L.colon}${L.kinds[point.kind] ?? proseOr(point.kind, L.unclassified)}`)
  lines.push(`- ${L.confidence}${L.colon}${L.confidences[point.confidence] ?? proseOr(point.confidence, L.unlabeled)}`)
  lines.push('')

  const stakes = prose(point.problem.stakes)
  const constraint = proseOr(point.problem.constraint, L.constraintMissing)
  const joined = stakes === '' ? constraint : `${constraint} —— ${stakes}`
  lines.push(`**${L.constraint}**${L.colon}${joined}`, '')

  lines.push(`**${L.alternatives}**`, '')
  if (point.alternatives.length === 0) lines.push(`- ${L.alternativesMissing}`)
  else {
    for (const item of point.alternatives) {
      const approach = proseOr(item.approach, L.unnamedApproach)
      const cost = prose(item.cost)
      lines.push(`- ${cost === '' ? approach : `${approach} —— ${cost}`}`)
    }
  }
  lines.push('')

  lines.push(`**${L.theirs}**`, '', proseOr(point.theirs.summary, L.theirsMissing), '')
  const evidence = evidenceBlock(point)
  if (evidence !== '') lines.push(evidence, '')

  lines.push(`**${L.mechanism}**`, '', proseOr(point.mechanism, L.mechanismMissing), '')

  lines.push(`**${L.tradeoffs}**`, '')
  if (point.tradeoffs.length === 0) lines.push(`- ${L.tradeoffsMissing}`)
  else {
    for (const item of point.tradeoffs) {
      const cost = proseOr(item.cost, L.unnamedCost)
      const hurts = prose(item.whenItHurts)
      lines.push(`- ${hurts === '' ? cost : `${cost} —— ${hurts}`}`)
    }
  }

  if (point.unknowns.length > 0) {
    lines.push('', `**${L.unknowns}**`, '')
    for (const item of point.unknowns) lines.push(`- ${prose(item)}`)
  }

  const recipe = recipeBlock(point, L)
  if (recipe !== '') lines.push('', recipe)

  return lines.join('\n')
}

function emptyState(doc: ReportDocument, L: Labels): string {
  const reasons: string[] = []
  for (const note of doc.notes) reasons.push(`${L.notePrefix}${L.colon}${prose(note)}`)
  for (const skip of doc.skipped) reasons.push(`${L.skipPrefix}${L.colon}${prose(skip)}`)
  for (const item of doc.notRendered) {
    reasons.push(`${L.notRenderedPrefix}${L.colon}${prose(item.pointId)}`)
  }
  for (const item of doc.validation.dropped) {
    reasons.push(
      `${L.droppedPrefix}${L.colon}${proseOr(item.pointId, L.unknownPoint)} —— ${prose(item.reason)}`,
    )
  }
  if (reasons.length === 0) reasons.push(L.noClues)

  const lines: string[] = [`## ${L.emptyHeading}`, '', L.emptyLede, '']
  for (const reason of reasons) lines.push(`- ${reason}`)
  return lines.join('\n')
}

function tail(doc: ReportDocument, L: Labels): string {
  const outside: string[] = []
  for (const skip of doc.skipped) outside.push(`- ${L.skipPrefix}${L.colon}${prose(skip)}`)
  for (const note of doc.notes) outside.push(`- ${L.notePrefix}${L.colon}${prose(note)}`)

  const withheld: string[] = [
    `- ${L.notRenderedCount(doc.notRendered.length)}`,
    `- ${L.downgradedCount(doc.validation.downgraded.length)}`,
    `- ${L.droppedCount(doc.validation.dropped.length)}`,
  ]
  for (const item of doc.validation.dropped) {
    withheld.push(
      `- ${L.droppedReason}${L.colon}${proseOr(item.pointId, L.unknownPoint)} —— ${prose(item.reason)}`,
    )
  }
  for (const item of doc.validation.downgraded) {
    withheld.push(
      `- ${L.downgradedReason}${L.colon}${proseOr(item.pointId, L.unknownPoint)} —— ${prose(item.reason)}`,
    )
  }

  const declared =
    doc.skipped.length > 0 ||
    doc.notes.length > 0 ||
    doc.notRendered.length > 0 ||
    doc.validation.dropped.length > 0 ||
    doc.validation.downgraded.length > 0

  if (!declared) return [`## ${L.tailHeading}`, '', `- ${L.nothingOmitted}`].join('\n')

  const lines: string[] = [`## ${L.tailHeading}`, '', `**${L.outsideHeading}**`, '']
  if (outside.length === 0) lines.push(`- ${L.noSkippedInput}`)
  else lines.push(...outside)

  lines.push('', `**${L.withheldHeading}**`, '')
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

/**
 * What the kernel saw, for the reader who wants to look themselves.
 *
 * The page above reports what the model could write about and verify. Everything
 * else the scan produced was, until now, thrown away at the end of the run: twenty
 * candidates scored and ranked, a module graph with 57 nodes, and the report said
 * "被预算裁掉的候选：12 个" without naming one. That is a strange place to spend
 * the effort and then discard it — the ranking is deterministic, costs nothing to
 * print, and every line of it is checkable by opening the file at that line.
 *
 * So this appendix inverts the emphasis: the prose above is what the model gave
 * you, this is what the machine found. Neither is verification of the other.
 */
/**
 * The nearest declaration at or above a line, in the same file.
 *
 * `structure.symbols` was computed on every run and read by nothing: 180 entries
 * written to disk and never opened. A line number is where a reader has to start
 * scrolling; the name of the function it sits in is where they start reading. This
 * is the whole value of that index, and it costs one lookup per candidate.
 */
function enclosingSymbol(
  symbols: readonly SymbolRef[],
  path: string,
  line: number,
): SymbolRef | null {
  let best: SymbolRef | null = null
  for (const symbol of symbols) {
    if (symbol.path !== path) continue
    if (symbol.line > line) continue
    // The closest declaration above wins: a method beats its class.
    if (best === null || symbol.line > best.line) best = symbol
  }
  return best
}

function appendix(input: ReportInput, L: Labels): string {
  const sections: string[] = []
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const structure = input.structure
  const symbols = Array.isArray(structure?.symbols) ? (structure?.symbols ?? []) : []

  if (candidates.length > 0) {
    const sorted = [...candidates].sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line,
    )
    const shown = sorted.slice(0, APPENDIX_CANDIDATES)

    sections.push(`## ${L.appendixCandidatesHeading}`)
    sections.push('')
    sections.push(L.appendixCandidatesLede(candidates.length))
    sections.push('')
    // The column only exists when the index did. Without symbols an empty column
    // would suggest nothing is declared there, which is a different statement.
    const withSymbol = symbols.length > 0
    sections.push(
      withSymbol
        ? `| ${L.appendixPosition} | ${L.appendixSymbol} | ${L.appendixKind} | ${L.appendixScore} | ${L.appendixRules} |`
        : `| ${L.appendixPosition} | ${L.appendixKind} | ${L.appendixScore} | ${L.appendixRules} |`,
    )
    sections.push(
      withSymbol ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- |',
    )
    for (const candidate of shown) {
      const matched = candidate.matched.map((item) => prose(item)).join('、')
      const location = inlineCode(`${candidate.path}:${candidate.line}`)
      const symbol = withSymbol ? enclosingSymbol(symbols, candidate.path, candidate.line) : null
      const where =
        symbol === null
          ? L.appendixNoSymbol
          : `${inlineCode(symbol.name)} (${prose(symbol.kind)})`
      sections.push(
        withSymbol
          ? `| ${location} | ${where} | ${prose(candidate.kind)} | ${candidate.score} | ${matched} |`
          : `| ${location} | ${prose(candidate.kind)} | ${candidate.score} | ${matched} |`,
      )
    }
    sections.push('')
    if (candidates.length > shown.length) {
      sections.push(L.appendixMore(candidates.length - shown.length))
      sections.push('')
    }

    const byKind = new Map<string, number>()
    for (const candidate of candidates) {
      byKind.set(candidate.kind, (byKind.get(candidate.kind) ?? 0) + 1)
    }
    const distribution = [...byKind.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([kind, count]) => `${prose(kind)} ${count}`)
      .join(L.listSeparator)
    sections.push(`**${L.appendixDistribution}**${L.colon}${distribution}`)
    sections.push('')
  }

  if (structure !== undefined && Array.isArray(structure.modules) && structure.modules.length > 0) {
    const inbound = new Map<string, number>()
    for (const module of structure.modules) {
      for (const edge of module.imports) {
        if (typeof edge.resolved !== 'string' || edge.resolved === '') continue
        inbound.set(edge.resolved, (inbound.get(edge.resolved) ?? 0) + 1)
      }
    }
    const hubs = [...inbound.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
    const leaves = structure.modules.filter((module) => !inbound.has(module.path))

    sections.push(`## ${L.appendixShapeHeading}`)
    sections.push('')
    sections.push(`- ${L.appendixModules(structure.modules.length, leaves.length)}`)
    if (hubs.length > 0) {
      sections.push(
        `- ${L.appendixHubs}: ${hubs
          .map(([name, count]) => `${inlineCode(name)} (${count})`)
          .join(L.listSeparator)}`,
      )
    }
    if (structure.unresolved > 0) {
      sections.push(`- ${L.appendixUnresolved(structure.unresolved)}`)
    }
    const entryPoints = input.profile.entryPoints
    if (entryPoints.length > 0) {
      sections.push(
        `- ${L.appendixEntries}: ${entryPoints.map((item) => inlineCode(item)).join(L.listSeparator)}`,
      )
    }
    const manifests = input.profile.manifests
    if (manifests.length > 0) {
      sections.push(
        `- ${L.appendixManifests}: ${manifests.map((item) => inlineCode(item)).join(L.listSeparator)}`,
      )
    }
    const yesNo = (value: boolean): string => (value ? L.yes : L.no)
    sections.push(
      `- ${L.appendixTooling(yesNo(input.profile.hasTests), yesNo(input.profile.hasCi), yesNo(input.profile.hasDocs))}`,
    )
    sections.push('')
    sections.push(L.appendixShapeNote)
    sections.push('')
  }

  // `scope.files` holds every analysed file with its size and line count, and the
  // report used to print the totals only — "26 个文件" with no way to ask which
  // one was the biggest. Where the mass sits is the first thing a reader orienting
  // in an unfamiliar repository wants.
  const files = Array.isArray(input.scope?.files) ? input.scope.files : []
  if (files.length > 1) {
    const largest = [...files]
      .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
      .slice(0, APPENDIX_FILES)
    const share = (lines: number): string => {
      const total = input.scope.totals.lines
      return total > 0 ? `${Math.round((lines / total) * 100)}%` : '—'
    }

    sections.push(`## ${L.appendixFilesHeading}`)
    sections.push('')
    sections.push(L.appendixFilesLede(largest.length, files.length))
    sections.push('')
    sections.push(
      `| ${L.appendixFilePath} | ${L.appendixFileLines} | ${L.appendixFileBytes} | ${L.appendixFileShare} |`,
    )
    sections.push('| --- | --- | --- | --- |')
    for (const file of largest) {
      sections.push(
        `| ${inlineCode(file.path)} | ${file.lines} | ${file.bytes} | ${share(file.lines)} |`,
      )
    }
    sections.push('')
    sections.push(L.appendixFilesNote)
    sections.push('')
  }

  return sections.join('\n')
}

/** How many candidates the appendix prints. Enough to browse, few enough to read. */
const APPENDIX_CANDIDATES = 20

/** How many files the size table prints. */
const APPENDIX_FILES = 10

export function renderMarkdown(input: ReportInput): string {
  const lang: Lang = input.lang ?? 'zh'
  const L = labelsFor(lang)
  const doc = buildReport(input)
  const sections: string[] = [`# ${proseOr(doc.repo, L.unknown)}`, brief(doc, L)]

  if (doc.points.length === 0) {
    sections.push(emptyState(doc, L))
  } else {
    doc.points.forEach((point, index) => sections.push(pointSection(point, index + 1, L)))
  }

  const extra = appendix(input, L)
  if (extra !== '') sections.push(extra)
  sections.push(tail(doc, L))
  return `${sections.join('\n\n')}\n`
}
