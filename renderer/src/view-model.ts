/**
 * What the window decides before it renders.
 *
 * Kept here, apart from `App.tsx`, because these are the rules that were wrong in
 * ways nobody could test while they lived inside a component: a trust figure that
 * only recognised the Chinese label, a history search that compared nothing, and a
 * "3 分钟前" that could read "-2 分钟前" on a clock that moved backwards. Each
 * function is pure, so the suite can hold it to the claim.
 */

import { parseMarkdown } from '../../src/render/parse-report.js'

export type RunSummary = {
  runId: string
  source: string
  startedAt: string
  points: number
  title: string
  /** Null when the run's validation artifact is missing or unreadable. */
  evidenceRate?: number | null
}

/** A run's start time as something a person reads, not an ISO string. */
export function whenText(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const minutes = Math.round((now - then) / 60_000)
  // A clock that is a few seconds behind should say "刚刚", not a negative count.
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(then).toLocaleDateString('zh-CN')
}

/**
 * The trust numbers the report states, in either language it can be written in.
 *
 * The renderer used to recognise only `已取证点占比：`, so an English report — which
 * `ana analyze --lang en` has always produced — showed "未知" in the rail above a
 * report that stated its evidence rate two lines below.
 */
export function trustOf(markdown: string): { evidence: string; points: string } {
  const zh = /已取证点占比：([\d.]+%|未知)/.exec(markdown)
  const en = /Points with followed evidence:\s*([\d.]+%|unknown)/i.exec(markdown)
  const points = (markdown.match(/^## \d+\. /gm) ?? []).length
  return { evidence: zh?.[1] ?? en?.[1] ?? '未知', points: String(points) }
}

/** History search: title, source and date are all things a person remembers. */
export function filterRuns<T extends RunSummary>(runs: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...runs]
  return runs.filter((run) => {
    const title = run.title.toLowerCase()
    const source = run.source.toLowerCase()
    const date = run.startedAt.slice(0, 10)
    return title.includes(needle) || source.includes(needle) || date.includes(needle)
  })
}

/** `0.61` → `61.0%`; a `null` rate is a dash, never a zero. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate < 0) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/** The signed difference, with the unit the row uses. */
export function formatDelta(before: number, after: number, format: 'count' | 'percent'): string {
  const diff = after - before
  if (diff === 0) return '不变'
  const sign = diff > 0 ? '+' : '−'
  const size = Math.abs(diff)
  return format === 'percent' ? `${sign}${(size * 100).toFixed(1)} 个百分点` : `${sign}${size}`
}

/** The report's top-level sections, in order, with the ids `ReportView` gives them. */
export function tocOf(markdown: string): Array<{ id: string; text: string }> {
  let index = 0
  const headings: Array<{ id: string; text: string }> = []
  for (const block of parseMarkdown(markdown)) {
    if (block.kind !== 'h2') continue
    headings.push({ id: `report-h2-${index}`, text: block.text })
    index += 1
  }
  return headings
}
