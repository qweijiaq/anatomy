/**
 * The window: one column, two states.
 *
 * Before a run, the page asks for a repository and a button. After a run, it
 * shows the report and keeps a narrow rail with the run's identity — repository,
 * model, how many points, and how many the analysis could not verify. That rail
 * is the honest part of the UI: a reader should be able to see the evidence rate
 * without scrolling to the bottom of the page.
 *
 * Nothing here talks to the network. The analysis runs in the main process; this
 * component watches a progress channel and renders what comes back.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, bridgeAvailable, type Progress, type SettingsView } from './api.js'
import { ReportView } from './components/ReportView.js'
import { SettingsPanel } from './components/SettingsPanel.js'
import { providerOf } from './providers.js'

const PHASE_LABEL: Record<string, string> = {
  acquire: '取回仓库…',
  analyse: '读代码、挑候选、让模型写分析…',
  done: '完成',
}

/** Pull the trust numbers out of the rendered markdown, for the rail. */
function trustOf(markdown: string): { evidence: string; points: string } {
  const rate = /已取证点占比：([\d.]+%)/.exec(markdown)
  const points = (markdown.match(/^## \d+\. /gm) ?? []).length
  return { evidence: rate?.[1] ?? '未知', points: String(points) }
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [repo, setRepo] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [runId, setRunId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!bridgeAvailable()) return
    void api()
      .settings.read()
      .then((next) => {
        setSettings(next)
        // First launch has no key: open settings immediately rather than showing a
        // button that can only fail.
        if (!next.apiKeyConfigured) setSettingsOpen(true)
      })
  }, [])

  useEffect(() => {
    if (!bridgeAvailable()) return
    return api().analysis.onProgress((next) => setProgress(next))
  }, [])

  const run = useCallback(async (): Promise<void> => {
    if (repo.trim() === '') {
      setError('请先填一个仓库地址，例如 https://github.com/owner/repo')
      return
    }
    setRunning(true)
    setError('')
    setMarkdown('')
    setProgress({ phase: 'acquire' })
    try {
      const result = await api().analysis.run({ repo: repo.trim(), top: settings?.topN ?? 8 })
      if (result.ok) {
        setMarkdown(result.markdown)
        setRunId(result.runId)
      } else {
        setError(result.message)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRunning(false)
    }
  }, [repo, settings])

  const trust = useMemo(() => trustOf(markdown), [markdown])
  const providerLabel = settings === null ? '' : providerOf(settings.provider).label

  if (!bridgeAvailable()) {
    return (
      <div className="boot">
        <p>这个页面需要在桌面应用里打开。</p>
        <p className="boot__hint">在项目根目录运行 npm run dev:desktop。</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true" />
          <span className="topbar__name">anatomy</span>
          <span className="topbar__tag">拆解一个项目，找出值得学的地方</span>
        </div>
        <div className="topbar__right">
          {settings !== null && (
            <button className="btn btn--ghost btn--sm" type="button" onClick={() => setSettingsOpen(true)}>
              {providerLabel} · {settings.model}
              {settings.apiKeyConfigured ? '' : ' · 未配置'}
            </button>
          )}
        </div>
      </header>

      <main className={markdown === '' ? 'main main--intro' : 'main main--report'}>
        {markdown === '' ? (
          <section className="intro">
            <h1 className="intro__title">
              给一个仓库地址，
              <br />
              还你它的设计笔记。
            </h1>
            <p className="intro__lede">
              每个结论都带着 <code className="inline-code">文件:行号</code> 和原文片段。
              校验不通过的说法不会出现在报告里——报告头部会写明有多少条证据没能核对。
            </p>

            <div className="runbar">
              <input
                className="input input--lg"
                placeholder="https://github.com/owner/repo 或本地路径"
                spellCheck={false}
                value={repo}
                disabled={running}
                onChange={(event) => setRepo(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !running) void run()
                }}
              />
              <button className="btn btn--primary btn--lg" type="button" onClick={() => void run()} disabled={running}>
                {running ? '分析中…' : '开始拆解'}
              </button>
            </div>

            {running && (
              <p className="progress" role="status">
                <span className="progress__dot" />
                {PHASE_LABEL[progress?.phase ?? 'acquire'] ?? '分析中…'}
              </p>
            )}

            {error !== '' && <p className="notice notice--error">{error}</p>}

            <ul className="hints">
              <li>先跑 `npm run scan` 之类不花 token 的步骤？命令行版本有，界面版第一版只做完整分析。</li>
              <li>分析一次大约 8 次模型请求，成本按你的模型价目表算。</li>
              <li>报告和证据都留在本机，不出设备。</li>
            </ul>
          </section>
        ) : (
          <>
            <aside className="rail">
              <div className="rail__block">
                <span className="rail__label">仓库</span>
                <span className="rail__value" title={repo}>
                  {repo}
                </span>
              </div>
              <div className="rail__block">
                <span className="rail__label">学习点</span>
                <span className="rail__value rail__value--big">{trust.points}</span>
              </div>
              <div className="rail__block">
                <span className="rail__label">已取证点占比</span>
                <span className="rail__value">{trust.evidence}</span>
              </div>
              <div className="rail__block">
                <span className="rail__label">run</span>
                <span className="rail__value rail__value--mono">{runId}</span>
              </div>
              <div className="rail__actions">
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => {
                    setMarkdown('')
                    setRunId('')
                    setProgress(null)
                  }}
                >
                  再拆一个
                </button>
              </div>
            </aside>
            <div className="paper">
              <ReportView markdown={markdown} />
            </div>
          </>
        )}
      </main>

      {settingsOpen && settings !== null && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}
