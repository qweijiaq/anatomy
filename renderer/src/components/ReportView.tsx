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

import { decodeEntities, parseMarkdown, type Block } from '../../../src/render/parse-report.js'

function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // The writer escaped `<` and `>` so a model's prose could not open an HTML block;
  // a markdown viewer would decode them, and this is not one. Without this a report
  // renders `&lt;key&gt;.json` while the evidence it cites says `<key>.json`.
  text = decodeEntities(text)
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
