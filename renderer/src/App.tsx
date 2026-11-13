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

import {
  api,
  bridgeAvailable,
  type AppSurvey,
  type Progress,
  type ReportSummary,
  type SettingsView,
} from './api.js'
import { AppSurveyView } from './components/AppSurveyView.js'
import { Select } from './components/Select.js'
import { ReportView } from './components/ReportView.js'
import { SettingsPanel } from './components/SettingsPanel.js'
import { providerOf } from './providers.js'

/**
 * What each stage is doing, in the reader's words.
 *
 * These are the stages `runAnalyze` actually reports, not a summary of them: the
 * judge loop is one model call per candidate, so it is the slow one and the one
 * that most needs a number attached.
 */
const PHASE_LABEL: Record<string, string> = {
  acquire: '取回仓库、建立索引',
  judge: '逐个候选点问模型',
  rank: '给已经取证的点排序',
  synthesise: '写开篇、挑最值得学的几条',
  report: '生成报告',
  analyse: '读代码、挑候选、让模型写分析…',
  done: '完成',
}

/**
 * A run's start time as something a person reads, not an ISO string.
 *
 * Relative wording inside the last day, because "刚刚" and "3 小时前" answer the
 * question the list is actually asked — which of these is the one I just ran.
 */
function whenText(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(then).toLocaleDateString('zh-CN')
}

/**
 * Which two surveys to compare.
 *
 * Backed by the hand-drawn `Select`, for the same reason as everywhere else: the
 * native popup ignores every token here. Each option carries the build digest,
 * because two analyses of the same app produced directory names that differ only in
 * that suffix — without it the list is two identical-looking strings.
 */
function DiffBar({
  surveys,
  before,
  after,
  onBefore,
  onAfter,
  onRun,
  onClose,
}: {
  surveys: AppSurvey[]
  before: string
  after: string
  onBefore: (value: string) => void
  onAfter: (value: string) => void
  onRun: () => void
  onClose: () => void
}): React.JSX.Element {
  const options = surveys
    .filter((survey) => (survey.dirName ?? '') !== '')
    .map((survey) => ({
      value: survey.dirName as string,
      label: `${survey.name} · ${survey.digest}`,
      hint: `${survey.surface.ipcOperations} 通道`,
    }))

  return (
    <div className="diffbar">
      <span className="diffbar__label">前</span>
      <Select value={before} options={options} onChange={onBefore} placeholder="选一份" />
      <span className="diffbar__label">后</span>
      <Select value={after} options={options} onChange={onAfter} placeholder="选一份" />
      <button className="btn btn--ghost btn--sm" type="button" onClick={onRun}>
        重新对比
      </button>
      <button className="btn btn--ghost btn--sm diffbar__close" type="button" onClick={onClose}>
        退出对比
      </button>
    </div>
  )
}

/**
 * The running analysis, in detail.
 *
 * A single "分析中" is honest but useless: the judge stage spends minutes making
 * one request per candidate, and a person watching a still spinner cannot tell
 * work from a hang. So: which stage, what it is working on, and — for the stages
 * that have a countable queue — a bar and an estimate of what is left.
 */
function ProgressLine({ progress }: { progress: Progress | null }): React.JSX.Element {
  const phase = progress?.phase ?? 'acquire'
  const label = PHASE_LABEL[phase] ?? '分析中…'
  const done = typeof progress?.done === 'number' ? progress.done : null
  const total = typeof progress?.total === 'number' && progress.total > 0 ? progress.total : null
  const ratio = done !== null && total !== null ? Math.min(1, done / total) : null

  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress__row">
        <span className="progress__dot" />
        <span className="progress__label">{label}</span>
        {done !== null && total !== null && (
          <span className="progress__count">
            {done} / {total}
          </span>
        )}
      </div>
      {ratio !== null && (
        <div className="progress__track" aria-hidden="true">
          <div className="progress__fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
      {typeof progress?.detail === 'string' && progress.detail !== '' && (
        <p className="progress__detail" title={progress.detail}>
          {progress.detail}
        </p>
      )}
    </div>
  )
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
  // 历史报告：磁盘上已经跑完的 run。读盘比缓存可靠——刚跑完的那次必须立刻出现。
  const [history, setHistory] = useState<ReportSummary[]>([])
  // 重建过的应用（走 CLI 的 inspect-app）。界面只读，不触发分析。
  const [surveys, setSurveys] = useState<AppSurvey[]>([])
  const [surveyOpen, setSurveyOpen] = useState(false)
  // 单份视图看的是哪一份。默认第一份，人可以在页头换。
  const [surveyDir, setSurveyDir] = useState('')
  // 对比：打开时固定两份，人自己挑，不靠「最新的两份」猜。
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffBefore, setDiffBefore] = useState('')
  const [diffAfter, setDiffAfter] = useState('')

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

  /** 每次切回首页或跑完一次都重新读盘：历史不能靠启动时那一次快照。 */
  const refreshHistory = useCallback(async (): Promise<void> => {
    if (!bridgeAvailable()) return
    try {
      const result = await api().report.list()
      if (result.ok) setHistory(result.runs)
    } catch {
      // 读不到历史不影响做分析，静默即可。
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  useEffect(() => {
    if (!bridgeAvailable()) return
    void api()
      .surveys.list()
      .then((result) => {
        if (result.ok && Array.isArray(result.surveys)) {
          setSurveys(result.surveys)
          // 默认：第二份当「前」，第一份当「后」——列表顺序是读盘顺序，不承诺时间，
          // 所以这只是起点，不是判断。
          const [newest, previous] = result.surveys
          setDiffAfter((current) => (current === '' ? (newest?.dirName ?? '') : current))
          setDiffBefore((current) => (current === '' ? (previous?.dirName ?? '') : current))
        }
      })
      .catch(() => {
        // A missing directory is not an error: nothing has been reconstructed yet.
      })
  }, [])

  /**
   * 最新两份重建结果的差异。
   *
   * 顺序按目录名里的摘要排不可靠，所以按加载顺序取最新的两份——survey 列表
   * 已经是 `readdir` 的顺序，不保证时间，因此显式按 evidenceId 去重后取前两个。
   */
  const openDiff = useCallback(async (): Promise<void> => {
    const before = diffBefore
    const after = diffAfter
    if (before === '' || after === '') {
      setError('先挑两份 survey。')
      return
    }
    if (before === after) {
      setError('前后选的是同一份，看不出差异。')
      return
    }
    setError('')
    try {
      const result = await api().surveys.diff(before, after)
      if (result.ok && typeof result.markdown === 'string') {
        setSurveyOpen(false)
        setDiffOpen(true)
        setMarkdown(result.markdown)
        setRunId('')
        setProgress(null)
      } else {
        setError(result.message ?? '算不出差异。')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [diffBefore, diffAfter])

  /** 打开一份旧报告：走和刚跑完完全相同的渲染路径。 */
  const openReport = useCallback(async (id: string): Promise<void> => {
    setError('')
    try {
      const result = await api().report.read(id)
      if (result.ok && typeof result.markdown === 'string') {
        setMarkdown(result.markdown)
        setRunId(id)
        setProgress(null)
      } else {
        setError(result.message ?? '这份报告读不出来。')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
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
      // 跑完立刻重读，新报告要马上出现在历史里。
      void refreshHistory()
    }
  }, [repo, settings, refreshHistory])

  // 目录选择：系统文件面板返回绝对路径，直接填进输入框，人还可以继续手改。
  const pickFolder = useCallback(async (): Promise<void> => {
    const picked = await api().app.pickFolder()
    if (picked.ok && typeof picked.path === 'string') {
      setRepo(picked.path)
      setError('')
    }
  }, [])

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
          {surveys.length > 1 && (
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => {
                setDiffOpen(true)
                setSurveyOpen(false)
                void openDiff()
              }}
              title="挑两份重建结果对比"
            >
              对比
            </button>
          )}
          {surveys.length > 0 && (
            <button
              className={`btn btn--ghost btn--sm ${surveyOpen ? 'btn--on' : ''}`}
              type="button"
              onClick={() => {
                setSurveyOpen((current) => !current)
                setMarkdown('')
              }}
              title="REA 重建过的应用"
            >
              应用 · {surveys.length}
            </button>
          )}
          {settings !== null && (
            <button className="btn btn--ghost btn--sm" type="button" onClick={() => setSettingsOpen(true)}>
              {providerLabel} · {settings.model}
              {settings.apiKeyConfigured ? '' : ' · 未配置'}
            </button>
          )}
        </div>
      </header>

      <main
        className={
          surveyOpen ? 'main main--intro' : markdown === '' ? 'main main--intro' : 'main main--report'
        }
      >
        {surveyOpen ? (
          <AppSurveyView
            survey={
              (surveys.find((item) => item.dirName === surveyDir) ?? surveys[0]) as AppSurvey
            }
            surveys={surveys}
            onSelect={setSurveyDir}
          />
        ) : markdown === '' ? (
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
              <button
                className="btn btn--ghost btn--lg runbar__pick"
                type="button"
                disabled={running}
                onClick={() => void pickFolder()}
                title="选择一个本地文件夹"
              >
                选择文件夹
              </button>
              <button className="btn btn--primary btn--lg" type="button" onClick={() => void run()} disabled={running}>
                {running ? '分析中…' : '开始拆解'}
              </button>
            </div>

            {running && <ProgressLine progress={progress} />}

            {error !== '' && <p className="notice notice--error">{error}</p>}

            <ul className="hints">
              <li>先跑 `npm run scan` 之类不花 token 的步骤？命令行版本有，界面版第一版只做完整分析。</li>
              <li>分析一次大约 8 次模型请求，成本按你的模型价目表算。</li>
              <li>报告和证据都留在本机，不出设备。</li>
            </ul>

            {history.length > 0 && (
              <section className="history" aria-label="历史报告">
                <h2 className="history__title">之前的报告</h2>
                <p className="history__lede">
                  每一次拆解都留在本机，点开就是当时生成的那一版，不会因为下次分析被覆盖。
                </p>
                <ul className="history__list">
                  {history.map((item) => (
                    <li key={item.runId}>
                      <button
                        type="button"
                        className={`history__row ${item.runId === runId ? 'history__row--current' : ''}`}
                        onClick={() => void openReport(item.runId)}
                      >
                        <span className="history__name">{item.title}</span>
                        <span className="history__meta">
                          {item.points} 个学习点 · {whenText(item.startedAt)}
                        </span>
                        <span className="history__open" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
              {diffOpen && <DiffBar
                surveys={surveys}
                before={diffBefore}
                after={diffAfter}
                onBefore={setDiffBefore}
                onAfter={setDiffAfter}
                onRun={() => void openDiff()}
                onClose={() => {
                  setDiffOpen(false)
                  setMarkdown('')
                }}
              />}
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
