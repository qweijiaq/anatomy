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
import { Select } from './Select.js'

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

/**
 * The order these are shown in, worst first, with the wording that stops them
 * reading as verdicts. `privileged` says "suggests", because that is all a name
 * can do — the handler behind it may be a stub.
 */
const GROUPS: ReadonlyArray<{ key: 'privileged' | 'write' | 'read' | 'event' | 'other'; label: string; hint: string }> = [
  { key: 'privileged', label: '能碰到系统', hint: '名字指向文件、进程、对话框或一次完整运行' },
  { key: 'write', label: '会改东西', hint: '名字里是写动作' },
  { key: 'read', label: '只读', hint: '名字里是读动作' },
  { key: 'event', label: '事件', hint: '监听而不是调用' },
  { key: 'other', label: '看不出', hint: '名字里没有可用动词' },
]

export function AppSurveyView({
  survey,
  surveys,
  onSelect,
}: {
  survey: AppSurvey
  /** Every survey on disk; rendered as a picker when there is more than one. */
  surveys: AppSurvey[]
  onSelect: (dirName: string) => void
}): React.JSX.Element {
  const partial = survey.surface.semantics !== 'partial' && survey.surface.semantics !== 'complete'
  const bridges = survey.modules.filter((module) => module.kind === 'context-bridge-api')
  const channels = survey.modules.filter((module) => module.kind === 'ipc-channel')

  return (
    <section className="survey">
      <header className="survey__head">
        <div>
          {surveys.length > 1 ? (
            // Hand-drawn like every other select here: the native popup ignores the
            // tokens, and this one sits inside a header with its own type.
            <div className="survey__picker">
              <Select
                value={survey.dirName ?? ''}
                onChange={onSelect}
                options={surveys.map((item) => ({
                  value: item.dirName ?? '',
                  label: `${item.name} · ${item.digest}`,
                  hint: `${item.surface.ipcOperations} 通道`,
                }))}
              />
            </div>
          ) : (
            <h1 className="survey__title">{survey.name}</h1>
          )}
          <p className="survey__meta">
            {survey.format} · {survey.digest} · 证据 <code className="inline-code">{survey.evidenceId.slice(0, 14)}</code>
          </p>
        </div>
        <span className="survey__badge">
          {survey.statistics.relevantFiles} 文件 / {survey.statistics.parsedJavaScriptFiles} 解析 /{' '}
          {survey.statistics.findings} 条事实
        </span>
      </header>

      {survey.retried && (
        <p className="notice notice--warn survey__retry">{survey.retryNote}</p>
      )}

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
                {GROUPS.map((group) => {
                  const names = survey.groups.members[group.key].filter(
                    (name) => bridge.members.includes(name),
                  )
                  if (names.length === 0) return null
                  return (
                    <div className="group" key={group.key}>
                      <h3 className="survey__h3">
                        {group.label}
                        <span className="survey__count">{names.length}</span>
                      </h3>
                      <ul className="chips chips--members">
                        {names.map((member) => (
                          <li
                            className={`chip ${group.key === 'privileged' ? 'chip--privileged' : ''}`}
                            key={member}
                          >
                            {member}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
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
            通道名是字面量，所以能读出来。分组只看名字，不是安全判定：
            <code className="inline-code">analysis:run</code> 和{' '}
            <code className="inline-code">app:info</code> 都是一条通道，但一个能跑完整分析，
            一个只回几个数字。
          </p>
          {channels.length === 0 ? (
            <p className="survey__note">这次分析没有读到 IPC 通道。</p>
          ) : (
            GROUPS.map((group) => {
              const names = survey.groups.channels[group.key]
              if (names.length === 0) return null
              return (
                <div className="group" key={group.key}>
                  <h3 className="survey__h3">
                    {group.label}
                    <span className="survey__count">{names.length}</span>
                    <span className="group__hint">{group.hint}</span>
                  </h3>
                  <ul className="chips chips--channels">
                    {names.map((name) => (
                      <li
                        className={`chip chip--channel ${
                          group.key === 'privileged' ? 'chip--privileged' : ''
                        } ${
                          group.key === 'event' ? '' : survey.surface.ambiguousTransmissions > 0 ? 'chip--unpaired' : ''
                        }`}
                        key={name}
                      >
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })
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
