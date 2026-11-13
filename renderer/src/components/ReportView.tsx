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

const CITE = /^`([^`]+:\d+-\d+)`$/
const FENCE = /^```/

/** A line-oriented pass. Anything it does not recognise stays a paragraph. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  let inFence = false
  let fence: string[] = []

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (FENCE.test(line)) {
      if (inFence) {
        blocks.push({ kind: 'code', text: fence.join('\n') })
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
    if (line.startsWith('# ')) {
      blocks.push({ kind: 'h1', text: line.slice(2) })
      continue
    }
    if (line.startsWith('## ')) {
      blocks.push({ kind: 'h2', text: line.slice(3) })
      continue
    }
    if (line.startsWith('### ')) {
      blocks.push({ kind: 'h3', text: line.slice(4) })
      continue
    }
    const cite = CITE.exec(line.trim())
    if (cite !== null) {
      const whole = cite[1] as string
      const split = whole.lastIndexOf(':')
      blocks.push({
        kind: 'cite',
        path: whole.slice(0, split),
        lines: whole.slice(split + 1),
      })
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      blocks.push({ kind: 'li', text: bullet[1] as string, ordered: false })
      continue
    }
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (numbered !== null) {
      blocks.push({ kind: 'li', text: numbered[1] as string, ordered: true })
      continue
    }
    if (line.startsWith('> ')) {
      blocks.push({ kind: 'quote', text: line.slice(2) })
      continue
    }
    blocks.push({ kind: 'p', text: line })
  }

  if (inFence && fence.length > 0) blocks.push({ kind: 'code', text: fence.join('\n') })
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

  return (
    <article className="report">
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
          default:
            return (
              <p className="report__p" key={index}>
                {inline(block.text)}
              </p>
            )
        }
      })}
    </article>
  )
}
