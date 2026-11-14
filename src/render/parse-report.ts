/**
 * The window's markdown parser, separated from the component that renders it.
 *
 * It lived in `ReportView.tsx`, and that file was the only surface in this project
 * with no tests — the reason given each time was that `tsconfig.test.json` does not
 * include `renderer/`. That was a configuration alibi, not a reason: this half is
 * pure and returns data, and a construct it does not recognise becomes a paragraph
 * of literal syntax, so a broken `<details>` shows the reader `<details>`. That
 * defect shipped once and was fixed by hand.
 *
 * `inline()` — bold and code spans — stays with the component, because it returns
 * React nodes.
 */

export type Block =
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
