/**
 * Two source analyses, side by side.
 *
 * This is a comparison of facts — counts, evidence rates, and which point titles
 * appeared or disappeared — not a diff of prose. The reports are written by a model,
 * so a sentence-level diff would invite reading a rephrasing as a change in the
 * repository.
 */

import type { RunDiff } from '../api.js'
import { formatDelta, formatRate } from '../view-model.js'

function shortId(id: string): string {
  return id.slice(0, 8)
}

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function RunDiffView({ diff, onClose }: { diff: RunDiff; onClose: () => void }): React.JSX.Element {
  const same = diff.comparable && diff.sameTree

  return (
    <article className="rundiff">
      <header className="rundiff__head">
        <div>
          <h1 className="rundiff__title">两次分析的对照</h1>
          <p className="rundiff__source">
            {diff.sameSource
              ? diff.before.source
              : `${diff.before.source} ↔ ${diff.after.source}`}
          </p>
        </div>
        <button className="btn btn--ghost btn--sm" type="button" onClick={onClose}>
          退出对比
        </button>
      </header>

      {diff.warnings.map((warning) => (
        <p className="notice notice--warn" key={warning}>
          {warning}
        </p>
      ))}

      <div className="rundiff__side">
        <div className="rundiff__run">
          <span className="rundiff__tag">前</span>
          <span className="rundiff__when">{when(diff.before.startedAt)}</span>
          <code className="inline-code">{shortId(diff.before.runId)}</code>
          {diff.before.sha !== '' && <span className="rundiff__sha">{diff.before.sha.slice(0, 7)}</span>}
        </div>
        <div className="rundiff__run">
          <span className="rundiff__tag">后</span>
          <span className="rundiff__when">{when(diff.after.startedAt)}</span>
          <code className="inline-code">{shortId(diff.after.runId)}</code>
          {diff.after.sha !== '' && <span className="rundiff__sha">{diff.after.sha.slice(0, 7)}</span>}
        </div>
      </div>

      <div className="report__table-wrap">
        <table className="report__table rundiff__table">
          <thead>
            <tr>
              <th>项目</th>
              <th>前</th>
              <th>后</th>
              <th>变化</th>
            </tr>
          </thead>
          <tbody>
            {diff.counters.map((row) => {
              const unknown = row.format === 'percent' && (row.before < 0 || row.after < 0)
              return (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>{row.format === 'percent' ? formatRate(row.before < 0 ? null : row.before) : row.before}</td>
                  <td>{row.format === 'percent' ? formatRate(row.after < 0 ? null : row.after) : row.after}</td>
                  <td>{unknown ? '—' : formatDelta(row.before, row.after, row.format)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {same && diff.addedTitles.length === 0 && diff.removedTitles.length === 0 && (
        <p className="rundiff__empty">
          两次分析读的是同一个提交，学习点的标题也完全相同。数字上的差别来自模型这一次的选择，不是代码变了。
        </p>
      )}

      {diff.addedTitles.length > 0 && (
        <section className="rundiff__block">
          <h2 className="rundiff__h2">后一次新出现的点</h2>
          <ul className="rundiff__list">
            {diff.addedTitles.map((title) => (
              <li className="rundiff__item rundiff__item--added" key={title}>
                {title}
              </li>
            ))}
          </ul>
        </section>
      )}

      {diff.removedTitles.length > 0 && (
        <section className="rundiff__block">
          <h2 className="rundiff__h2">后一次没有的点</h2>
          <ul className="rundiff__list">
            {diff.removedTitles.map((title) => (
              <li className="rundiff__item rundiff__item--removed" key={title}>
                {title}
              </li>
            ))}
          </ul>
          <p className="rundiff__note">
            「没有」不等于「代码里不存在」：候选召回和模型这一次的判断都会影响它是否被写出来。
          </p>
        </section>
      )}
    </article>
  )
}
