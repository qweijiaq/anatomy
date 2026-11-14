/**
 * The in-window markdown parser.
 *
 * `src/render/parse-report.ts` turns the stored markdown into blocks, and
 * `ReportView.tsx` maps them to React elements. The parser used to live inside the
 * component, which is why it had no tests: it sat in a directory no config reaching
 * `tests/` included. Split out, it is tested like everything else.
 *
 * It matters more than most parsers. A construct it does not recognise becomes a
 * paragraph of literal syntax, so a broken `<details>` shows the reader
 * `<details>` — which is exactly the defect that shipped once and was fixed by hand.
 */

import { describe, expect, it } from 'vitest'

import { decodeEntities, parseMarkdown } from '../src/render/parse-report.js'

function kinds(markdown: string): string[] {
  return parseMarkdown(markdown).map((block) => block.kind)
}

describe('parseMarkdown', () => {
  it('recognises the shapes a real report contains', () => {
    const real = [
      '# repo',
      '',
      '## 这次分析在解决什么',
      '',
      '一个仓库。',
      '',
      '**约束**：先跑通再说',
      '',
      '<details>',
      '<summary>要在自己项目里用</summary>',
      '',
      '**前置条件**',
      '',
      '- 无',
      '',
      '</details>',
      '',
      '| 项 | 前 | 后 |',
      '| --- | --- | --- |',
      '| 通道 | 1 | 2 |',
      '',
    ].join('\n')
    expect(kinds(real)).toEqual(['h1', 'h2', 'p', 'p', 'details', 'table'])
    const details = parseMarkdown(real).find((block) => block.kind === 'details')
    if (details?.kind !== 'details') throw new Error('expected a details block')
    expect(details.summary).toBe('要在自己项目里用')
    // The body is parsed, not swallowed: a bullet inside a folded block is a bullet.
    expect(details.body.map((block) => block.kind)).toContain('li')
  })

  it('keeps a table out of the prose', () => {
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(blocks).toHaveLength(1)
    const table = blocks[0]
    if (table?.kind !== 'table') throw new Error('expected a table')
    expect(table.head).toEqual(['a', 'b'])
    // The `| --- |` separator is structure, not a row of dashes.
    expect(table.rows).toEqual([['1', '2']])
  })

  it('reads a citation as a location rather than prose', () => {
    const blocks = parseMarkdown('`lib/http.mjs:70-88`\n')
    expect(blocks[0]).toMatchObject({ kind: 'cite', path: 'lib/http.mjs', lines: '70-88' })
  })

  it('keeps code fences verbatim, including markdown inside them', () => {
    const blocks = parseMarkdown('```\n## not a heading\n**not bold**\n```\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', text: '## not a heading\n**not bold**' })
  })

  it('recognises an indented drop reason as its own block', () => {
    const blocks = parseMarkdown('- 丢弃原因：public/admin.js:283:complexity —— 行号对不上\n')
    expect(blocks[0]).toMatchObject({
      kind: 'reason',
      label: '丢弃原因',
      where: 'public/admin.js:283:complexity',
    })
  })

  it('leaves a lone pipe in prose as prose', () => {
    // The report's own text contains `ip|slug`; a table needs pipes at both ends.
    expect(kinds('每次用 `ip|slug` 拼 key\n')).toEqual(['p'])
  })
})

describe('decodeEntities', () => {
  /**
   * `markdown.ts` escapes `<` and `>` so a model's prose cannot open an HTML block.
   * A markdown renderer decodes them again — the file reads correctly on GitHub — but
   * this project's readers are a terminal and a React component, and neither does.
   *
   * Found on a real report: prose about a TTS cache rendered `&lt;key&gt;.json` while
   * `ana inspect electron/tts.ts:20-22`, the line it cites, showed `<key>.json`. The
   * page disagreed with its own evidence.
   */
  it('turns the five entities the writer emits back into characters', () => {
    expect(decodeEntities('落盘为 &lt;key&gt;.json')).toBe('落盘为 <key>.json')
    expect(decodeEntities('&quot;a&quot; &#39;b&#39;')).toBe('"a" \'b\'')
    expect(decodeEntities('a &amp; b')).toBe('a & b')
  })

  it('decodes &amp; last, so a double escape does not become a tag', () => {
    // Decoding `&amp;` first would turn this into `<details>`, which the report parser
    // really would treat as a block.
    expect(decodeEntities('&amp;lt;details&amp;gt;')).toBe('&lt;details&gt;')
  })

  it('leaves ordinary text alone', () => {
    expect(decodeEntities('一段没有实体的文字 <details> 也不该被改写')).toBe(
      '一段没有实体的文字 <details> 也不该被改写',
    )
  })
})
