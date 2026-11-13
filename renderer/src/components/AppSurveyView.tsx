/**
 * What an application looks like from the outside.
 *
 * This is the REA half of the product, and the reason it is a separate view rather
 * than another report: anatomy reads source, REA reconstructs an application that
 * has none. The numbers below are REA's, not ours — including the ones that are
 * zero because its analyzer ran out of heap, which is why the limitations block is
 * not a footnote here but the third column of the layout.
 */

import type { AppSurvey } from '../api.js'

/** The Electron surface, as four groups. Zeros are shown, never hidden. */
const SURFACE_ROWS: ReadonlyArray<{
  label: string
  pick: (survey: AppSurvey) => number
  hint: string
}> = [
  { label: '窗口', pick: (s) => s.surface.browserWindows, hint: 'BrowserWindow 数量' },
  { label: 'preload', pick: (s) => s.surface.preloadEntrypoints, hint: '预加载脚本入口' },
  { label: 'contextBridge', pick: (s) => s.surface.contextBridgeApis, hint: '暴露的 API 对象' },
  { label: 'API 成员', pick: (s) => s.surface.exposedApiMembers, hint: '渲染进程能调到的成员总数' },
  { label: 'IPC 操作', pick: (s) => s.surface.ipcOperations, hint: 'invoke / send / on 的调用点' },
  { label: '字面通道', pick: (s) => s.surface.ipcLiteralChannels, hint: '通道名是字面量，可读' },
  { label: '主进程 handler', pick: (s) => s.surface.ipcMainHandlers, hint: '注册的接收端' },
  { label: '未配对', pick: (s) => s.surface.ambiguousTransmissions, hint: '有发送没有确定的接收端' },
]

function Bars({ items, unit }: { items: Array<[string, number]>; unit: string }): React.JSX.Element {
  const max = Math.max(1, ...items.map(([, count]) => count))
  return (
    <ul className="bars">
      {items.map(([label, count]) => (
        <li className="bars__row" key={label}>
          <span className="bars__label" title={label}>
            {label}
          </span>
          <span className="bars__track" aria-hidden="true">
            <span className="bars__fill" style={{ width: `${Math.round((count / max) * 100)}%` }} />
          </span>
          <span className="bars__count">
            {count} {unit}
          </span>
        </li>
      ))}
    </ul>
  )
}

function groupBy<T>(items: T[], key: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export function AppSurveyView({ survey }: { survey: AppSurvey }): React.JSX.Element {
  const partial = survey.surface.semantics !== 'partial' && survey.surface.semantics !== 'complete'
  const bridges = survey.modules.filter((module) => module.kind === 'context-bridge-api')
  const channels = survey.modules.filter((module) => module.kind === 'ipc-channel')

  return (
    <section className="survey">
      <header className="survey__head">
        <div>
          <h1 className="survey__title">{survey.name}</h1>
          <p className="survey__meta">
            {survey.format} · {survey.digest} · 证据 <code className="inline-code">{survey.evidenceId.slice(0, 14)}</code>
          </p>
        </div>
        <span className="survey__badge">
          {survey.statistics.relevantFiles} 文件 / {survey.statistics.parsedJavaScriptFiles} 解析 /{' '}
          {survey.statistics.findings} 条事实
        </span>
      </header>

      <div className="survey__grid">
        <section className="survey__block">
          <h2 className="survey__h2">Electron 暴露面</h2>
          <p className="survey__note">
            {partial
              ? `语义覆盖 ${survey.surface.semantics}：这些数字是下界，不是全貌。`
              : '这些数字来自 REA 对打包产物的静态重建。'}
          </p>
          <dl className="surface">
            {SURFACE_ROWS.map((row) => {
              const value = row.pick(survey)
              return (
                <div className={`surface__cell ${value === 0 ? 'surface__cell--zero' : ''}`} key={row.label}>
                  <dt className="surface__label" title={row.hint}>
                    {row.label}
                  </dt>
                  <dd className="surface__value">{value}</dd>
                </div>
              )
            })}
          </dl>
        </section>

        <section className="survey__block">
          <h2 className="survey__h2">contextBridge 暴露了什么</h2>
          {bridges.length === 0 ? (
            <p className="survey__note">这次分析没有读到 contextBridge。</p>
          ) : (
            bridges.map((bridge) => (
              <div className="bridge" key={bridge.id}>
                <p className="bridge__name">
                  渲染进程拿到 <code className="inline-code">{bridge.label}</code>
                  {bridge.members.length > 0 && ` ，可以调用 ${bridge.members.length} 个成员`}
                </p>
                <ul className="chips chips--members">
                  {bridge.members.map((member) => (
                    <li className="chip" key={member}>
                      {member}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>

        <section className="survey__block survey__block--wide">
          <h2 className="survey__h2">
            IPC 通道
            <span className="survey__count">{channels.length}</span>
          </h2>
          <p className="survey__note">
            通道名是字面量，所以能读出来。标红的是 REA 没找到确定接收端的——
            没有接收端不等于没被处理，也不等于安全。
          </p>
          {channels.length === 0 ? (
            <p className="survey__note">这次分析没有读到 IPC 通道。</p>
          ) : (
            <ul className="chips chips--channels">
              {channels.map((channel) => (
                <li
                  className={`chip chip--channel ${
                    survey.surface.ambiguousTransmissions > 0 ? 'chip--unpaired' : ''
                  }`}
                  key={channel.id}
                  title={channel.operation === '' ? channel.id : `${channel.operation}`}
                >
                  {channel.label}
                  {channel.operation !== '' && (
                    <span className="chip__op">{channel.operation}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="survey__block">
          <h2 className="survey__h2">模块图</h2>
          {survey.modules.length === 0 ? (
            <p className="survey__note">{survey.graphOmitted === '' ? '没有重建出模块。' : survey.graphOmitted}</p>
          ) : (
            <>
              <p className="survey__note">
                {survey.modules.length} 个节点 · {survey.relations.length} 条边
              </p>
              <h3 className="survey__h3">节点类型</h3>
              <Bars items={groupBy(survey.modules, (m) => m.kind)} unit="个" />
              <h3 className="survey__h3">关系类型</h3>
              <Bars items={groupBy(survey.relations, (r) => r.relation)} unit="条" />
            </>
          )}
        </section>

        <section className="survey__block survey__block--wide">
          <h2 className="survey__h2">
            没看的部分
            <span className="survey__count">{survey.limitations.length}</span>
          </h2>
          <p className="survey__note">
            REA 原话，没有改写。数到 0 的那几项要连着这里一起读：它可能是真的没有，也可能是没读到。
          </p>
          <ul className="limits">
            {survey.limitations.map((item, index) => (
              <li className="limits__item" key={index}>
                {item}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  )
}
