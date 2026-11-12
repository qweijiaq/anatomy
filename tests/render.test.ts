/**
 * The report is the only surface the reader touches, so these tests pin the two
 * promises it makes. Every claim shows the citation and the verbatim snippet a
 * reader can check; and the page says out loud what it did not look at. The
 * third theme is containment: model-written prose may contain fences, HTML or
 * `</details>`, and none of it may break the page's own structure.
 */

import { describe, expect, it } from 'vitest'

import type {
  Evidence,
  LearningPoint,
  Profile,
  ReportInput,
  Scope,
  ValidationResult,
} from '../src/contracts/types.js'
import { renderJson } from '../src/render/json.js'
import { renderMarkdown } from '../src/render/markdown.js'

// --- fixtures -------------------------------------------------------------

/** Deliberately Chinese: the snippet is code, and code is never translated. */
const chineseSnippet = 'const 队列 = []\n队列.push(1)'

function evidenceOf(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    path: 'src/a.ts',
    startLine: 12,
    endLine: 14,
    snippet: chineseSnippet,
    ...over,
  }
}

function pointOf(over: Partial<LearningPoint> = {}): LearningPoint {
  return {
    id: 'p1',
    title: '用队列把并发写串起来',
    kind: 'architecture',
    problem: { constraint: '写操作必须幂等', stakes: '重试会把同一行写两次' },
    alternatives: [{ approach: '加一把全局锁', cost: '吞吐掉一半' }],
    theirs: { summary: '把写请求排队，交给单线程消费', evidence: [evidenceOf()] },
    mechanism: '单线程消费让幂等检查变成顺序判断',
    tradeoffs: [{ cost: '延迟变高', whenItHurts: '低延迟读路径' }],
    confidence: 'high',
    unknowns: ['持久化队列的恢复语义没看'],
    recipe: {
      prereqs: ['有一个可重放的写日志'],
      minimalForm: 'queue.push(job)\nawait drain()',
      avoidWhen: ['写本身很便宜'],
    },
    ...over,
  }
}

const scope: Scope = {
  root: '/tmp/repos/anatomy-fixture',
  files: [{ path: 'src/a.ts', bytes: 400, lines: 14, language: 'typescript' }],
  excluded: [
    { reason: 'gitignore', count: 5 },
    { reason: 'vendored', count: 2 },
  ],
  totals: { files: 10, bytes: 4096, lines: 120 },
  byLanguage: { typescript: 9, python: 1 },
}

const profile: Profile = {
  languages: { typescript: 9, python: 1 },
  manifests: ['package.json'],
  entryPoints: ['src/a.ts'],
  hasTests: true,
  hasCi: false,
  hasDocs: true,
  notes: ['python 文件不支持：这一版只解析 TypeScript'],
}

const validation: ValidationResult = {
  kept: [],
  downgraded: [],
  dropped: [{ pointId: 'p-gone', reason: '引用行号与片段不符' }],
  stats: { evidenceRate: 0.75, droppedEvidence: 2, avgEvidence: 2.5 },
}

/** The input the run was asked about: what the page's heading names. */
const source = 'https://github.com/example/anatomy-fixture'

function reportOf(over: Partial<ReportInput> = {}): ReportInput {
  const points = [pointOf()]
  return {
    source,
    problem: '这个仓库把写路径收敛成单线程队列。',
    topFive: ['用队列把并发写串起来'],
    points,
    validation: { ...validation, kept: points },
    profile,
    scope,
    skipped: ['tests/fixtures/big.json：超出单文件预算'],
    ...over,
  }
}

const input = reportOf()

/** Opening and closing fences, ignoring info strings. */
const fenceCount = (md: string): number =>
  md.split('\n').filter((line) => /^`{3,}/.test(line)).length

// --- structure ------------------------------------------------------------

describe('renderMarkdown — one page, in the promised order', () => {
  it('opens with the source it was asked about and puts the brief before the points', () => {
    const md = renderMarkdown(input)

    // The title is the short name a reader would recognise; the exact source it
    // was asked about is stated in the 口径 block, where it is evidence.
    expect(md.split('\n')[0]).toBe('# anatomy-fixture')
    expect(md).toContain(`- 来源：${source}`)
    const problem = md.indexOf('## 这次分析在解决什么')
    const topFive = md.indexOf('## 最值得学的 1 件事')
    const firstPoint = md.indexOf('## 1. 用队列把并发写串起来')
    const tail = md.indexOf('## 没看的部分')

    expect(problem).toBeGreaterThan(-1)
    expect(topFive).toBeGreaterThan(problem)
    expect(firstPoint).toBeGreaterThan(topFive)
    expect(tail).toBeGreaterThan(firstPoint)
    expect(md.endsWith('\n')).toBe(true)
  })

  it('shows the problem, the top five and the three trust numbers', () => {
    const md = renderMarkdown(input)

    expect(md).toContain('这个仓库把写路径收敛成单线程队列。')
    expect(md).toContain('1. 用队列把并发写串起来')
    expect(md).toContain('已取证点占比：75.0%')
    expect(md).toContain('被丢弃证据数：2')
    expect(md).toContain('每点平均证据数：2.5')
  })

  it('formats the numbers from validation.stats, without recomputing them', () => {
    const md = renderMarkdown(
      reportOf({
        validation: { ...validation, stats: { evidenceRate: 0.4, droppedEvidence: 7, avgEvidence: 1.333 } },
      }),
    )

    expect(md).toContain('已取证点占比：40.0%')
    expect(md).toContain('被丢弃证据数：7')
    expect(md).toContain('每点平均证据数：1.333')
  })

  it('states what was analysed and what was excluded', () => {
    const md = renderMarkdown(input)

    expect(md).toContain('规模：10 个文件 / 4096 字节 / 120 行')
    expect(md).toContain('排除：gitignore 5、vendored 2')
    expect(md).toContain('语言：typescript 9、python 1')
    expect(md).toContain('/tmp/repos/anatomy-fixture')
  })
})

// --- evidence -------------------------------------------------------------

describe('renderMarkdown — every claim shows its evidence', () => {
  it('prints the citation and the snippet verbatim', () => {
    const md = renderMarkdown(input)

    expect(md).toContain('`src/a.ts:12-14`')
    expect(md).toContain(chineseSnippet)
    // The snippet is code: no translation, no whitespace surgery.
    expect(md).not.toContain('队列 = [].push')
  })

  it('keeps a snippet that contains a fence inside a longer fence', () => {
    const snippet = '```\nconst a = 1\n```\nconst b = 2'
    const md = renderMarkdown(
      reportOf({ points: [pointOf({ theirs: { summary: 's', evidence: [evidenceOf({ snippet })] } })] }),
    )

    expect(md).toContain(snippet)
    // The wrapper is at least four backticks, so the inner ``` cannot close it.
    const delimiters = md.split('\n').filter((line) => /^`{4,}$/.test(line))
    expect(delimiters.length).toBeGreaterThanOrEqual(2)
    expect(delimiters.length % 2).toBe(0)
    expect(md).toContain('**为什么有效**')
  })

  it('does not let a point without a checkable citation into the page', () => {
    const ghost = pointOf({
      id: 'p-ghost',
      title: '没有证据的点',
      theirs: { summary: '听我说', evidence: [] },
    })

    const md = renderMarkdown(reportOf({ points: [ghost] }))

    expect(md).not.toContain('没有证据的点')
    expect(md).toContain('没有可核对证据的点：1 个')
    expect(md).toContain('## 没找到值得学的点')
  })

  it('rejects an evidence item whose citation cannot be followed', () => {
    const bad = pointOf({
      theirs: {
        summary: 's',
        evidence: [evidenceOf({ path: '', startLine: 0, endLine: -1 })],
      },
    })

    const md = renderMarkdown(reportOf({ points: [bad] }))

    expect(md).not.toContain('## 1.')
    expect(md).toContain('## 没找到值得学的点')
  })
})

// --- containment ----------------------------------------------------------

describe('renderMarkdown — model prose cannot break the page', () => {
  it('neutralizes HTML in a title instead of opening a details block', () => {
    const md = renderMarkdown(
      reportOf({ points: [pointOf({ title: '用 <details> 藏起配方 ``` 这样' })] }),
    )

    expect(md).toContain('&lt;details&gt;')
    expect(md).toContain('\\`\\`\\`')
    expect(md).not.toContain('用 <details>')
    // Exactly one raw block: the recipe's own.
    expect(md.split('<details>').length - 1).toBe(1)
    expect(md.split('</details>').length - 1).toBe(1)
  })

  it('neutralizes fences and closing tags inside mechanism prose', () => {
    const mechanism = '它靠 `details` 标签\n```\n</details>\n```\n结束'
    const md = renderMarkdown(reportOf({ points: [pointOf({ mechanism })] }))

    expect(md).toContain('&lt;/details&gt;')
    expect(md).toContain('\\`\\`\\`')
    // Only the recipe may open or close a block.
    expect(md.split('</details>').length - 1).toBe(1)
    expect(md.split('<details>').length - 1).toBe(1)
  })

  it('collapses multiline prose so it cannot inject a heading', () => {
    const md = renderMarkdown(
      reportOf({ points: [pointOf({ mechanism: '第一行\n## 伪造的章节\n第三行' })] }),
    )

    expect(md.split('\n').some((line) => line.startsWith('## 伪造的章节'))).toBe(false)
    expect(md).toContain('第一行 ## 伪造的章节 第三行')
  })

  it('collapses the recipe into a closed details block', () => {
    const md = renderMarkdown(input)

    expect(md).toContain('<details>')
    expect(md).toContain('<summary>要在自己项目里用</summary>')
    expect(md).toContain('有一个可重放的写日志')
    expect(md).toContain('queue.push(job)\nawait drain()')
    expect(md).toContain('写本身很便宜')
    const open = md.indexOf('<details>')
    expect(md.indexOf('</details>')).toBeGreaterThan(open)
  })

  it('renders no details block at all when the recipe is null', () => {
    const md = renderMarkdown(reportOf({ points: [pointOf({ recipe: null })] }))

    expect(md).toContain('## 1. 用队列把并发写串起来')
    expect(md).not.toContain('<details>')
  })
})

// --- empty report ---------------------------------------------------------

describe('renderMarkdown — an empty result is still a complete page', () => {
  const md = renderMarkdown(reportOf({ points: [], topFive: [] }))

  it('says there was nothing worth learning and explains why', () => {
    expect(md).toContain('# anatomy-fixture')
    expect(md).toContain('## 没找到值得学的点')
    expect(md).toContain('python 文件不支持')
    expect(md).toContain('tests/fixtures/big.json')
  })

  it('still carries the brief, the numbers and the tail', () => {
    expect(md).toContain('这个仓库把写路径收敛成单线程队列。')
    expect(md).toContain('已取证点占比：75.0%')
    expect(md).toContain('规模：10 个文件')
    expect(md).toContain('## 没看的部分')
  })

  it('does not invent a point section', () => {
    expect(md).not.toContain('## 1.')
  })
})

// --- tail -----------------------------------------------------------------

describe('renderMarkdown — the tail is honest about coverage', () => {
  it('lists skipped input, unsupported languages and the rejected judgements', () => {
    const md = renderMarkdown(input)

    expect(md).toContain('跳过：tests/fixtures/big.json：超出单文件预算')
    expect(md).toContain('备注：python 文件不支持')
    expect(md).toContain('被丢弃的点：1 个')
    expect(md).toContain('p-gone —— 引用行号与片段不符')
  })

  it('says so when nothing was left out', () => {
    const md = renderMarkdown(
      reportOf({ profile: { ...profile, notes: [] }, skipped: [], validation: { ...validation, dropped: [] } }),
    )

    expect(md).toContain('## 没看的部分')
    expect(md).toContain('没有需要声明的遗漏')
  })
})

// --- json -----------------------------------------------------------------

describe('renderJson — the same data, machine-readable', () => {
  it('is stable, pretty and newline-terminated', () => {
    const text = renderJson(input)

    expect(text).toBe(renderJson(input))
    expect(text.startsWith('{\n  "')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('round-trips to an equivalent object', () => {
    const parsed = JSON.parse(renderJson(input))

    expect(parsed.repo).toBe('anatomy-fixture')
    expect(parsed.problem).toBe(input.problem)
    expect(parsed.topFive).toEqual(input.topFive)
    expect(parsed.trust).toEqual(input.validation.stats)
    expect(parsed.analysis.root).toBe(input.scope.root)
    expect(parsed.analysis.totals).toEqual(input.scope.totals)
    expect(parsed.analysis.excluded).toEqual(input.scope.excluded)
    expect(parsed.points).toEqual(input.points)
    expect(parsed.skipped).toEqual(input.skipped)
    expect(parsed.notRendered).toEqual([])
  })

  it('keeps the snippet verbatim and the title unescaped', () => {
    const title = '用 <details> 藏起配方'
    const parsed = JSON.parse(renderJson(reportOf({ points: [pointOf({ title })] })))

    expect(parsed.points[0].title).toBe(title)
    expect(parsed.points[0].theirs.evidence[0].snippet).toBe(chineseSnippet)
  })

  it('reports a point it could not show instead of passing it through', () => {
    const ghost = pointOf({ id: 'p-ghost', theirs: { summary: 's', evidence: [] } })
    const parsed = JSON.parse(renderJson(reportOf({ points: [ghost] })))

    expect(parsed.points).toEqual([])
    expect(parsed.notRendered).toEqual([
      { pointId: 'p-ghost', reason: '没有可核对的证据（path:startLine-endLine 或原文片段缺失）' },
    ])
  })

  it('never throws on a malformed point', () => {
    const broken = reportOf({ points: [[] as unknown as LearningPoint] })

    expect(renderJson(broken)).toContain('"points": []')
    expect(renderMarkdown(broken)).toContain('## 没找到值得学的点')
  })
})

// --- a re-rendered run re-checks its citations ---------------------------

/** The reason the report gives for withholding a point nobody can follow. */
const WITHHELD =
  '没有可核对的证据（path:startLine-endLine 或原文片段缺失）'

/**
 * A re-rendered run trusts nothing off disk: `ana report` prints evidence it
 * never read from a file, so a stored or hand-edited citation must still name a
 * path a reader could open and a line range a reader could navigate.
 */
function citedBy(path: string, startLine: number, endLine: number): ReportInput {
  return reportOf({
    points: [
      pointOf({
        id: 'p-cited',
        theirs: {
          summary: 's',
          evidence: [evidenceOf({ path, startLine, endLine })],
        },
      }),
    ],
  })
}

describe('normalizeEvidence — a stored citation is checked before it is printed', () => {
  it('still renders a citation that names a real relative path and range', () => {
    const parsed = JSON.parse(renderJson(citedBy('src/a.ts', 12, 14)))

    expect(parsed.points).toHaveLength(1)
    expect(parsed.points[0].theirs.evidence[0]).toMatchObject({
      path: 'src/a.ts',
      startLine: 12,
      endLine: 14,
    })
    expect(parsed.notRendered).toEqual([])
  })

  it('refuses an absolute path', () => {
    const parsed = JSON.parse(renderJson(citedBy('/etc/passwd', 1, 1)))

    expect(parsed.points).toEqual([])
    expect(parsed.notRendered).toEqual([{ pointId: 'p-cited', reason: WITHHELD }])
  })

  it('refuses a path that climbs out of the tree with ..', () => {
    const parsed = JSON.parse(renderJson(citedBy('src/../../secrets.ts', 12, 14)))

    expect(parsed.points).toEqual([])
    expect(parsed.notRendered).toEqual([{ pointId: 'p-cited', reason: WITHHELD }])
  })

  it('refuses line numbers that are non-positive or reversed', () => {
    const ranges: Array<[number, number]> = [
      [0, 1],
      [-3, 12],
      [12, 4],
    ]
    for (const [startLine, endLine] of ranges) {
      const parsed = JSON.parse(renderJson(citedBy('src/a.ts', startLine, endLine)))

      expect(parsed.points).toEqual([])
      expect(parsed.notRendered).toEqual([{ pointId: 'p-cited', reason: WITHHELD }])
    }
  })

  it('refuses a line number no source file could reach', () => {
    const parsed = JSON.parse(renderJson(citedBy('src/a.ts', 1, 10_000_000)))

    expect(parsed.points).toEqual([])
    expect(parsed.notRendered).toEqual([{ pointId: 'p-cited', reason: WITHHELD }])
  })
})

// --- accounting for every point ------------------------------------------

/** Nothing declared but the malformed points: the tail has only them to report. */
function bareOf(over: Partial<ReportInput> = {}): ReportInput {
  return reportOf({
    topFive: [],
    skipped: [],
    profile: { ...profile, notes: [] },
    validation: { ...validation, dropped: [], downgraded: [], kept: [] },
    ...over,
  })
}

describe('buildReport — a point that cannot be normalised is still declared', () => {
  it('declares a nested array where a point should be', () => {
    const md = renderMarkdown(bareOf({ points: [[pointOf()] as unknown as LearningPoint] }))

    expect(md).not.toContain('没有需要声明的遗漏')
    expect(md).toContain('没有可核对证据的点：1 个')
  })

  it('declares every null in the list', () => {
    const input = bareOf({ points: [null, null] as unknown as LearningPoint[] })
    const md = renderMarkdown(input)

    expect(md).not.toContain('没有需要声明的遗漏')
    expect(md).toContain('没有可核对证据的点：2 个')
    expect(JSON.parse(renderJson(input)).notRendered).toHaveLength(2)
  })

  it('declares a points field that is not a list at all', () => {
    const md = renderMarkdown(bareOf({ points: {} as unknown as LearningPoint[] }))

    expect(md).not.toContain('没有需要声明的遗漏')
    expect(md).toContain('## 没看的部分')
  })

  it('carries a reason for each withheld point, never an empty one', () => {
    const parsed = JSON.parse(
      renderJson(bareOf({ points: ['p1', null] as unknown as LearningPoint[] })),
    )

    expect(parsed.notRendered).toHaveLength(2)
    for (const item of parsed.notRendered) expect(item.reason).not.toBe('')
  })
})

describe('renderMarkdown — the top list does not advertise a withheld point', () => {
  it('marks a top-five entry whose section the page withheld', () => {
    const withheld = pointOf({
      id: 'p-absent',
      title: 'advertised but absent',
      theirs: { summary: 's', evidence: [] },
    })
    const md = renderMarkdown(
      reportOf({
        points: [pointOf(), withheld],
        topFive: ['用队列把并发写串起来', 'advertised but absent'],
      }),
    )

    expect(md).toContain('1. 用队列把并发写串起来')
    expect(md).toContain('advertised but absent（未进正文）')
    expect(md).not.toContain('2. advertised but absent\n')
    expect(md).not.toContain('## 2. advertised but absent')
    expect(md).toContain('没有可核对证据的点：1 个')
  })

  it('leaves a top-five entry unmarked when its section is on the page', () => {
    const md = renderMarkdown(input)

    expect(md).toContain('1. 用队列把并发写串起来')
    expect(md).not.toContain('未进正文')
  })
})

describe('renderMarkdown — an unmeasured number is not a zero', () => {
  it('prints 未知 when the run carried no validation stats', () => {
    const md = renderMarkdown(
      reportOf({ validation: { ...validation, stats: undefined as unknown as ValidationResult['stats'] } }),
    )

    expect(md).toContain('已取证点占比：未知')
    expect(md).toContain('被丢弃证据数：未知')
    expect(md).toContain('每点平均证据数：未知')
    expect(md).not.toContain('已取证点占比：0')
  })

  it('keeps an absent statistic absent in the json', () => {
    const parsed = JSON.parse(
      renderJson(
        reportOf({ validation: { ...validation, stats: undefined as unknown as ValidationResult['stats'] } }),
      ),
    )

    expect(parsed.trust).toEqual({})
  })
})

describe('renderMarkdown — blank declarations are not omissions', () => {
  it('filters blank skipped entries instead of printing bare bullets', () => {
    const md = renderMarkdown(
      reportOf({ skipped: ['', '   '], profile: { ...profile, notes: [] }, validation: { ...validation, dropped: [] } }),
    )

    expect(md).not.toContain('- 跳过：')
    expect(md).toContain('没有需要声明的遗漏')
  })

  it('filters blank notes as well', () => {
    const md = renderMarkdown(
      reportOf({ skipped: [], profile: { ...profile, notes: [' ', ''] }, validation: { ...validation, dropped: [] } }),
    )

    expect(md).not.toContain('- 备注：')
    expect(md).toContain('没有需要声明的遗漏')
  })
})

describe('renderMarkdown — the heading counts what is listed', () => {
  it('uses the actual number of top items', () => {
    const md = renderMarkdown(reportOf({ topFive: ['用队列把并发写串起来'] }))

    expect(md).toContain('## 最值得学的 1 件事')
    expect(md).not.toContain('5 件事')
  })

  it('still names the section when nothing was selected', () => {
    const md = renderMarkdown(reportOf({ points: [], topFive: [] }))

    expect(md).toContain('## 没找到值得学的点')
    expect(md).not.toContain('0 件事')
  })
})
