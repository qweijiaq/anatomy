/**
 * The report, rendered in the window.
 *
 * The markdown is produced by the CLI's renderer — the same function, not a
 * second implementation — so what a person reads here and what lands in
 * `report.md` cannot drift. This component's job is only to make it readable:
 * headings get weight, citations become chips, code blocks keep their monospace
 * and their horizontal scroll.
 *
 * The structure is intentionally small: the report's own shape (title, brief,
 * sections, `## 没看的部分`) is finite and known, so a full markdown parser would
 * be a dependency paid to re-learn something we already know.
 */

import { useMemo } from 'react'

type Block =
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'li'; text: string; ordered: boolean }
  | { kind: 'code'; text: string }
  | { kind: 'cite'; path: string; lines: string }
  | { kind: 'quote'; text: string }
  /** An open `<details>` block: its summary, then the blocks it wraps. */
  | { kind: 'details'; summary: string; body: Block[] }
  /** `丢弃原因：path:line:kind —— why`, kept as three fields so it can be laid out. */
  | { kind: 'reason'; label: string; where: string; why: string }
  /** A pipe table. First row is the header; the `| --- |` row is dropped. */
  | { kind: 'table'; head: string[]; rows: string[][] }

const CITE = /^`([^`]+:\d+-\d+)`$/
const FENCE = /^```/
/**
 * The two HTML tags `render/markdown.ts` emits on purpose — the recipe block.
 *
 * Everything else stays escaped by that renderer, so recognising exactly these
 * two is not an XSS door: a model-authored `<details>` arrives as
 * `&lt;details&gt;` and is rendered as text. Without this, the recipe showed up
 * as three lines of literal tag names between the prose.
 */
const DETAILS_OPEN = /^<details>$/
const DETAILS_CLOSE = /^<\/details>$/
const SUMMARY = /^<summary>(.*)<\/summary>$/
/**
 * `丢弃原因：<path>:<line>:<kind> —— <why>` and its 降级 twin.
 *
 * The location can itself contain a colon on Windows paths and the kind is our
 * own vocabulary, so the split anchors on the em dash: everything before it is
 * the location, everything after is the explanation.
 */
const REASON = /^[-*]\s+(丢弃原因|降级原因|跳过|备注)：(.+?)\s+——\s+(.*)$/
/**
 * A pipe table row.
 *
 * The app-diff report prints counters as a table, and without this the reader sees
 * eleven lines of `| 窗口 | 0 | 0 | — |`. Detection is deliberately strict — a line
 * must start and end with a pipe — because plenty of prose contains one.
 */
const TABLE_ROW = /^\|(.+)\|$/
const TABLE_RULE = /^\|[-: |]+\|$/

/** A line-oriented pass. Anything it does not recognise stays a paragraph. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  let inFence = false
  let fence: string[] = []
  // Open `<details>` blocks, innermost last. The recipe is one level deep today;
  // a stack costs nothing and keeps nested blocks from merging into the outer one.
  const open: Array<{ summary: string; body: Block[] }> = []
  const target = (): Block[] =>
    open.length > 0 ? (open[open.length - 1] as { body: Block[] }).body : blocks
  const push = (block: Block): void => {
    target().push(block)
  }
  /** The block a continuation belongs to, or nothing. */
  const current = (): Block | undefined => {
    const list = target()
    return list[list.length - 1]
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (FENCE.test(line)) {
      if (inFence) {
        push({ kind: 'code', text: fence.join('\n') })
        fence = []
        inFence = false
      } else {
        inFence = true
      }
      continue
    }
    if (inFence) {
      fence.push(raw)
      continue
    }

    if (line.trim() === '') continue

    const tableRow = TABLE_ROW.exec(line.trim())
    if (tableRow !== null) {
      const cells = (tableRow[1] as string).split('|').map((cell) => cell.trim())
      const last = current()
      if (last !== undefined && last.kind === 'table') {
        if (!TABLE_RULE.test(line.trim())) last.rows.push(cells)
        continue
      }
      if (!TABLE_RULE.test(line.trim())) {
        push({ kind: 'table', head: cells, rows: [] })
        continue
      }
    }

    if (DETAILS_OPEN.test(line.trim())) {
      open.push({ summary: '展开', body: [] })
      continue
    }
    if (DETAILS_CLOSE.test(line.trim())) {
      const closedBlock = open.pop()
      if (closedBlock !== undefined) {
        blocks.push({ kind: 'details', summary: closedBlock.summary, body: closedBlock.body })
      }
      continue
    }
    const summary = SUMMARY.exec(line.trim())
    if (summary !== null && open.length > 0) {
      ;(open[open.length - 1] as { summary: string }).summary = summary[1] as string
      continue
    }

    if (line.startsWith('# ')) {
      push({ kind: 'h1', text: line.slice(2) })
      continue
    }
    if (line.startsWith('## ')) {
      push({ kind: 'h2', text: line.slice(3) })
      continue
    }
    if (line.startsWith('### ')) {
      push({ kind: 'h3', text: line.slice(4) })
      continue
    }
    const cite = CITE.exec(line.trim())
    if (cite !== null) {
      const whole = cite[1] as string
      const split = whole.lastIndexOf(':')
      push({
        kind: 'cite',
        path: whole.slice(0, split),
        lines: whole.slice(split + 1),
      })
      continue
    }
    // `丢弃原因：public/admin.js:283:complexity —— <why>`: a location, a kind and an
    // explanation crammed into one bullet. As plain text the three blur together
    // and the reader has to re-parse the line themselves.
    const reason = REASON.exec(line)
    if (reason !== null) {
      push({ kind: 'reason', label: reason[1] as string, where: reason[2] as string, why: (reason[3] as string).trim() })
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      push({ kind: 'li', text: bullet[1] as string, ordered: false })
      continue
    }
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (numbered !== null) {
      push({ kind: 'li', text: numbered[1] as string, ordered: true })
      continue
    }
    if (line.startsWith('> ')) {
      push({ kind: 'quote', text: line.slice(2) })
      continue
    }
    push({ kind: 'p', text: line })
  }

  if (inFence && fence.length > 0) push({ kind: 'code', text: fence.join('\n') })
  // An unclosed `<details>` still renders its body rather than swallowing it.
  while (open.length > 0) {
    const leftover = open.pop()
    if (leftover !== undefined) {
      blocks.push({ kind: 'details', summary: leftover.summary, body: leftover.body })
    }
  }
  return blocks
}

/** `**bold**` and inline code become elements; nothing else is interpreted. */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let index = 0
  let match = pattern.exec(text)
  while (match !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      parts.push(<strong key={`b${index}`}>{token.slice(2, -2)}</strong>)
    } else {
      parts.push(
        <code className="inline-code" key={`c${index}`}>
          {token.slice(1, -1)}
        </code>,
      )
    }
    last = match.index + token.length
    index += 1
    match = pattern.exec(text)
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function ReportView({ markdown }: { markdown: string }): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown])

  return <article className="report">{renderBlocks(blocks)}</article>
}

/** One block list. Recursive because `<details>` holds its own list. */
function renderBlocks(blocks: Block[]): React.ReactNode {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'h1':
            return (
              <h1 className="report__title" key={index}>
                {block.text}
              </h1>
            )
          case 'h2':
            return (
              <h2 className="report__section" key={index}>
                {block.text}
              </h2>
            )
          case 'h3':
            return (
              <h3 className="report__sub" key={index}>
                {block.text}
              </h3>
            )
          case 'li':
            return (
              <p className={block.ordered ? 'report__num' : 'report__bullet'} key={index}>
                {inline(block.text)}
              </p>
            )
          case 'code':
            return (
              <pre className="report__code" key={index}>
                <code>{block.text}</code>
              </pre>
            )
          case 'cite':
            return (
              <span className="report__cite" key={index} title={`${block.path}:${block.lines}`}>
                {block.path}
                <span className="report__cite-lines">:{block.lines}</span>
              </span>
            )
          case 'quote':
            return (
              <blockquote className="report__quote" key={index}>
                {inline(block.text)}
              </blockquote>
            )
          case 'reason':
            return (
              <div className="report__reason" key={index}>
                <span className="report__reason-label">{block.label}</span>
                <code className="report__reason-where">{block.where}</code>
                <span className="report__reason-why">{inline(block.why)}</span>
              </div>
            )
          case 'table':
            return (
              <div className="report__table-wrap" key={index}>
                <table className="report__table">
                  <thead>
                    <tr>
                      {block.head.map((cell, cellIndex) => (
                        <th key={cellIndex}>{cell}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'details':
            return (
              <details className="report__details" key={index}>
                <summary className="report__summary">{block.summary}</summary>
                <div className="report__details-body">{renderBlocks(block.body)}</div>
              </details>
            )
          default:
            return (
              <p className="report__p" key={index}>
                {inline(block.text)}
              </p>
            )
        }
      })}
    </>
  )
}
