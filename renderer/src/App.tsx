/**
 * The window: one column, and the modes it can be in.
 *
 * Before a run, the page asks for a repository and a button. After a run, it shows
 * the report and keeps a narrow rail with the run's identity — repository, model,
 * how many points, and how many the analysis could not verify. That rail is the
 * honest part of the UI: a reader should be able to see the evidence rate without
 * scrolling to the bottom of the page.
 *
 * The same page also reads stored reports, compares two analyses, and shows the
 * applications REA reconstructed. Those modes share the shell but not their state:
 * a comparison bar left over a fresh report, or a repository name left over from a
 * previous run, is the kind of thing this file now resets on purpose.
 *
 * Nothing here talks to the network. The analysis runs in the main process; this
 * component watches a progress channel and renders what comes back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  bridgeAvailable,
  type AppSurvey,
  type EvidenceReply,
  type Progress,
  type ReportSummary,
  type RunDiff,
  type RunUsage,
  type SettingsView,
} from './api.js'
import { AppSurveyView } from './components/AppSurveyView.js'
import { AskPanel } from './components/AskPanel.js'
import { EvidencePanel } from './components/EvidencePanel.js'
import { ReportView } from './components/ReportView.js'
import { RunDiffView } from './components/RunDiffView.js'
import { Select } from './components/Select.js'
import { SettingsPanel } from './components/SettingsPanel.js'
import { providerOf } from './providers.js'
import { costOfTokens, formatUsd, priceOf } from './pricing.js'
import { filterRuns, formatRate, tocOf, trustOf, whenText } from './view-model.js'

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
      <Select
        value={before}
        options={options}
        onChange={onBefore}
        placeholder="选一份"
        ariaLabel="对比的前一份应用重建"
      />
      <span className="diffbar__label">后</span>
      <Select
        value={after}
        options={options}
        onChange={onAfter}
        placeholder="选一份"
        ariaLabel="对比的后一份应用重建"
      />
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

/** The report's sections, in the rail, as jump targets. */
function ReportToc({
  items,
  onJump,
}: {
  items: Array<{ id: string; text: string }>
  onJump: (id: string) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <nav className="toc" aria-label="报告目录">
      <span className="rail__label">目录</span>
      <ul className="toc__list">
        {items.map((item) => (
          <li key={item.id}>
            <button className="toc__link" type="button" onClick={() => onJump(item.id)}>
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [version, setVersion] = useState('')
  const [repo, setRepo] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [runId, setRunId] = useState('')
  /** Where the open report came from. The input box is not that answer. */
  const [reportSource, setReportSource] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [usage, setUsage] = useState<RunUsage | null>(null)
  const [exported, setExported] = useState<{
    dir: string
    files: string[]
    modelCalls: number
    enrichError?: string
  } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [enrichExport, setEnrichExport] = useState(false)

  // 历史报告：磁盘上已经跑完的 run。读盘比缓存可靠——刚跑完的那次必须立刻出现。
  const [history, setHistory] = useState<ReportSummary[]>([])
  const [historyQuery, setHistoryQuery] = useState('')

  // 重建过的应用（走 CLI 的 inspect-app）。界面只读，不触发分析。
  const [surveys, setSurveys] = useState<AppSurvey[]>([])
  const [surveyOpen, setSurveyOpen] = useState(false)
  // 单份视图看的是哪一份。默认第一份，人可以在页头换。
  const [surveyDir, setSurveyDir] = useState('')
  // 对比：打开时固定两份，人自己挑，不靠「最新的两份」猜。
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffBefore, setDiffBefore] = useState('')
  const [diffAfter, setDiffAfter] = useState('')

  // 两次源码分析的对照。
  const [runDiffOpen, setRunDiffOpen] = useState(false)
  const [runDiff, setRunDiff] = useState<RunDiff | null>(null)
  const [runBefore, setRunBefore] = useState('')
  const [runAfter, setRunAfter] = useState('')

  // 零 token 预扫的结果。它不是报告，只是一张「哪里值得看」的清单。
  const [preview, setPreview] = useState<Array<{ path: string; line: number; kind: string; score: number; matched: string[] }>>([])
  // 预扫结果属于哪个仓库。换仓库后旧表不能继续冒充新的。
  const [previewRepo, setPreviewRepo] = useState('')
  const [scanning, setScanning] = useState(false)

  const [forgetting, setForgetting] = useState('')

  // 一条引用的原文片段。
  const [evidenceWhere, setEvidenceWhere] = useState('')
  const [evidenceReply, setEvidenceReply] = useState<EvidenceReply | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)

  const mainRef = useRef<HTMLElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)

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
      .catch((failure: unknown) => {
        setError(`读不到本机设置：${failure instanceof Error ? failure.message : String(failure)}`)
      })
  }, [])

  useEffect(() => {
    if (!bridgeAvailable()) return
    void api()
      .app.info()
      .then((info) => setVersion(info.version))
      .catch(() => {
        // A missing version is cosmetic; the window still works.
      })
  }, [])

  useEffect(() => {
    if (!bridgeAvailable()) return
    return api().analysis.onProgress((next) => setProgress(next))
  }, [])

  /** Follow the system theme; the token block already carries both palettes. */
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset['theme'] = query.matches ? 'dark' : 'light'
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
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

  // A CLI run made while the window is open should appear without a restart: the
  // window regaining focus is the moment the user expects the list to be current.
  useEffect(() => {
    const onFocus = (): void => {
      void refreshHistory()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshHistory])

  useEffect(() => {
    if (!bridgeAvailable()) return
    void api()
      .surveys.list()
      .then((result) => {
        if (result.ok && Array.isArray(result.surveys)) {
          setSurveys(result.surveys)
          // 默认：第一份当「后」，第二份当「前」。列表现在按文件时间从新到旧，
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

  // The newest two runs are the useful default for a comparison; the user can change
  // either picker before pressing the button.
  useEffect(() => {
    if (history.length < 2) return
    setRunAfter((current) => (current === '' ? history[0]?.runId ?? '' : current))
    setRunBefore((current) => (current === '' ? history[1]?.runId ?? '' : current))
  }, [history])

  // A new report, comparison or app survey starts at the top. Reusing the scroll
  // container otherwise opens the next document halfway down.
  useEffect(() => {
    paperRef.current?.scrollTo({ top: 0 })
    mainRef.current?.scrollTo({ top: 0 })
    setCopied(false)
    setExported(null)
  }, [markdown, runDiff, surveyDir, surveyOpen])

  /**
   * 最新两份重建结果的差异。
   *
   * 顺序按目录名里的摘要排不可靠，所以按列表顺序取最新的两份——列表已经按
   * survey.json 的时间从新到旧排序。
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
        setRunDiff(null)
        setDiffOpen(true)
        setUsage(null)
        setMarkdown(result.markdown)
        setRunId('')
        setReportSource('')
        setProgress(null)
      } else {
        setError(result.message ?? '算不出差异。')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [diffBefore, diffAfter])

  const openRunDiff = useCallback(async (): Promise<void> => {
    if (runBefore === '' || runAfter === '') {
      setError('先挑两次分析。')
      return
    }
    if (runBefore === runAfter) {
      setError('前后选的是同一次分析，看不出差异。')
      return
    }
    setError('')
    try {
      const result = await api().report.diff(runBefore, runAfter)
      if (result.ok && result.diff !== undefined) {
        setDiffOpen(false)
        setSurveyOpen(false)
        setRunDiff(result.diff)
        setMarkdown('')
        setRunId('')
        setReportSource('')
        setProgress(null)
        setRunDiffOpen(false)
      } else {
        setError(result.message ?? '算不出差异。')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [runBefore, runAfter])

  /**
   * 删除一份存下来的分析。
   *
   * 两段式：第一次点把按钮变成「真的删？」，三秒后自己复原。删除没有撤销，而一个
   * 弹窗要自己画、要抢焦点、要处理 Esc——为一个动作不值得。二次确认同样能拦住误点。
   */
  const removeStored = useCallback(
    async (kind: 'run' | 'app', id: string): Promise<void> => {
      if (forgetting !== id) {
        setForgetting(id)
        window.setTimeout(() => setForgetting((current) => (current === id ? '' : current)), 3000)
        return
      }
      setForgetting('')
      const result = await api().report.forget(kind, id)
      if (!result.ok) {
        setError(result.message ?? '删不掉。')
        return
      }
      if (kind === 'run') {
        void refreshHistory()
        if (runId === id) {
          setMarkdown('')
          setRunId('')
          setReportSource('')
          setUsage(null)
        }
        if (runDiff?.before.runId === id || runDiff?.after.runId === id) setRunDiff(null)
        setRunBefore((current) => (current === id ? '' : current))
        setRunAfter((current) => (current === id ? '' : current))
      } else {
        const remaining = surveys.filter((item) => item.dirName !== id)
        setSurveys(remaining)
        if (surveyDir === id) setSurveyDir('')
        if (remaining.length === 0) setSurveyOpen(false)
        if (diffBefore === id || diffAfter === id) {
          setDiffOpen(false)
          setMarkdown('')
          setDiffBefore('')
          setDiffAfter('')
        }
      }
    },
    [forgetting, runId, runDiff, refreshHistory, surveys, surveyDir, diffBefore, diffAfter],
  )

  /**
   * 先扫一眼：不花 token，只列候选项。
   *
   * 绝大多数人打开一个陌生仓库时想先知道「哪里有料」，而不是先付一次完整分析的
   * 钱。CLI 一直有 `ana scan`，窗口没有——这是把最便宜的那一步补上。
   */
  const previewScan = useCallback(async (): Promise<void> => {
    if (repo.trim() === '') {
      setError('先填一个仓库地址，或者点「选择文件夹」。')
      return
    }
    setScanning(true)
    setError('')
    const target = repo.trim()
    try {
      const result = await api().analysis.scan(target, 12)
      if (result.ok && Array.isArray(result.candidates)) {
        setPreview(result.candidates)
        setPreviewRepo(target)
      } else {
        setError(result.message ?? '扫不出来。')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setScanning(false)
    }
  }, [repo])

  /**
   * 复制报告原文。
   *
   * 用剪贴板 API 而不是走主进程：内容已经在渲染进程里，绕一圈没有意义，而且
   * `navigator.clipboard` 在 Electron 的窗口里是可用的。
   */
  const copyReport = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown)
      setError('')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [markdown])

  /** 整套产出：默认不调用模型，写成 `.ana/exports/<runId>`。 */
  const exportAll = useCallback(async (): Promise<void> => {
    if (runId === '') return
    setExporting(true)
    setError('')
    try {
      const result = await api().report.export(runId, { enrich: enrichExport })
      if (result.ok && typeof result.dir === 'string') {
        setExported({
          dir: result.dir,
          files: result.files ?? [],
          modelCalls: result.modelCalls ?? 0,
          ...(result.enrichError === undefined ? {} : { enrichError: result.enrichError }),
        })
      } else {
        setError(result.message ?? '导出失败。')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setExporting(false)
    }
  }, [runId, enrichExport])

  /** 在文件管理器里显示这份报告。磁盘上的它和窗口里的是同一个文件。 */
  const revealReport = useCallback(async (): Promise<void> => {
    const result = await api().report.reveal(runId)
    if (!result.ok) setError(result.message ?? '找不到这份报告的文件。')
  }, [runId])

  /** 打开一份旧报告：走和刚跑完完全相同的渲染路径。 */
  const openReport = useCallback(
    async (id: string): Promise<void> => {
      setError('')
      try {
        const result = await api().report.read(id)
        if (result.ok && typeof result.markdown === 'string') {
          const stored = history.find((item) => item.runId === id)
          setMarkdown(result.markdown)
          setRunId(id)
          setReportSource(stored?.source ?? '')
          setUsage(result.usage ?? null)
          setProgress(null)
          setRunDiff(null)
          setDiffOpen(false)
          setEvidenceWhere('')
        } else {
          setError(result.message ?? '这份报告读不出来。')
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    },
    [history],
  )

  const run = useCallback(async (): Promise<void> => {
    if (repo.trim() === '') {
      setError('请先填一个仓库地址，例如 https://github.com/owner/repo')
      return
    }
    if (settings !== null && !settings.apiKeyConfigured) {
      setError('还没有配置 API Key。先在设置里填一个，再开始拆解。')
      setSettingsOpen(true)
      return
    }
    setRunning(true)
    setError('')
    setMarkdown('')
    setRunId('')
    setReportSource('')
    setRunDiff(null)
    setDiffOpen(false)
    setEvidenceWhere('')
    setUsage(null)
    setProgress({ phase: 'acquire' })
    try {
      const result = await api().analysis.run({ repo: repo.trim(), top: settings?.topN ?? 8 })
      if (result.ok) {
        setMarkdown(result.markdown)
        setRunId(result.runId)
        setReportSource(repo.trim())
        setUsage(result.usage ?? null)
        // The run remembers its repository; re-read so the "最近" row is current
        // without waiting for the next launch.
        void api()
          .settings.read()
          .then((next) => setSettings(next))
          .catch(() => {
            // A stale recent list is cosmetic.
          })
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

  /** 继续一次中断的分析：复用已判的候选，结果写成一个新的 run。 */
  const resumeRun = useCallback(
    async (id: string): Promise<void> => {
      setRunning(true)
      setError('')
      setProgress({ phase: 'acquire' })
      setMarkdown('')
      setRunId('')
      setRunDiff(null)
      setDiffOpen(false)
      try {
        const result = await api().analysis.resume(id)
        if (result.ok) {
          const stored = history.find((item) => item.runId === id)
          setMarkdown(result.markdown)
          setRunId(result.runId)
          setReportSource(stored?.source ?? '')
          setUsage(result.usage ?? null)
        } else {
          setError(result.message)
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setRunning(false)
        void refreshHistory()
      }
    },
    [history, refreshHistory],
  )

  // 目录选择：系统文件面板返回绝对路径，直接填进输入框，人还可以继续手改。
  const pickFolder = useCallback(async (): Promise<void> => {
    const picked = await api().app.pickFolder()
    if (picked.ok && typeof picked.path === 'string') {
      setRepo(picked.path)
      setError('')
    }
  }, [])

  const openEvidence = useCallback(
    async (file: string, lines: string): Promise<void> => {
      if (runId === '') return
      const [startText, endText] = lines.split('-')
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        setError(`这条引用的行号读不出来：${file}:${lines}`)
        return
      }
      setEvidenceWhere(`${file}:${lines}`)
      setEvidenceReply(null)
      setEvidenceLoading(true)
      setError('')
      try {
        setEvidenceReply(await api().report.evidence(runId, file, start, end))
      } catch (failure) {
        setEvidenceReply({
          ok: false,
          message: failure instanceof Error ? failure.message : String(failure),
        })
      } finally {
        setEvidenceLoading(false)
      }
    },
    [runId],
  )

  const price = priceOf(settings?.priceIn ?? null, settings?.priceOut ?? null)
  const trust = useMemo(() => trustOf(markdown), [markdown])
  const toc = useMemo(() => tocOf(markdown), [markdown])
  const shownHistory = useMemo(() => filterRuns(history, historyQuery), [history, historyQuery])
  const providerLabel = settings === null ? '' : providerOf(settings.provider).label
  const keyMissing = settings !== null && !settings.apiKeyConfigured
  const previewCurrent = previewRepo === repo.trim() && preview.length > 0
  const recent = (settings?.lastRepos ?? []).filter((item) => item !== repo.trim()).slice(0, 3)

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
                setRunDiff(null)
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
                setRunDiff(null)
                setDiffOpen(false)
              }}
              title="REA 重建过的应用"
            >
              应用 · {surveys.length}
            </button>
          )}
          {settings !== null && (
            <button
              className="btn btn--ghost btn--sm topbar__settings"
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="模型、报告语言与 Key"
            >
              设置 · {providerLabel} · {settings.model}
              {keyMissing ? ' · 未配置' : ''}
            </button>
          )}
        </div>
      </header>

      {error !== '' && (
        <div className="banner" role="alert">
          <span className="banner__text">{error}</span>
          <button className="banner__close" type="button" aria-label="关闭这条错误" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}

      <main
        className={markdown !== '' || runDiff !== null ? 'main main--report' : 'main'}
        ref={mainRef}
      >
        {surveyOpen ? (
          <AppSurveyView
            survey={surveys.find((item) => item.dirName === surveyDir) ?? surveys[0]}
            surveys={surveys}
            onSelect={setSurveyDir}
            onForget={(id) => void removeStored('app', id)}
            forgetting={forgetting}
          />
        ) : markdown === '' && runDiff === null ? (
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
                  // An IME uses Enter to commit a candidate. Starting a paid run on
                  // that keystroke is the Chinese-input bug this guard exists for.
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter' && !running && !scanning) void run()
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
              <button
                className="btn btn--primary btn--lg"
                type="button"
                onClick={() => void run()}
                disabled={running || scanning}
              >
                {keyMissing ? '先配置 Key' : running ? '分析中…' : '开始拆解'}
              </button>
            </div>

            <div className="runbar__secondary">
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                onClick={() => void previewScan()}
                disabled={running || scanning}
                title="不花 token，只列出值得看的位置"
              >
                {scanning ? '扫描中…' : '先扫一眼'}
              </button>
              <span className="runbar__note">不调用模型，也不花 token；只是列出值得先看的位置。</span>
            </div>

            {recent.length > 0 && (
              <div className="recent" aria-label="最近分析过的仓库">
                <span className="recent__label">最近</span>
                {recent.map((item) => (
                  <button className="recent__chip" type="button" key={item} onClick={() => setRepo(item)}>
                    {item}
                  </button>
                ))}
              </div>
            )}

            {keyMissing && (
              <p className="notice notice--warn notice--action">
                还没有配置模型 Key，完整分析需要一个。
                <button className="btn btn--ghost btn--sm" type="button" onClick={() => setSettingsOpen(true)}>
                  去设置
                </button>
              </p>
            )}

            {running && <ProgressLine progress={progress} />}

            {previewCurrent && (
              <section className="preview" aria-label="预扫结果">
                <h2 className="preview__title">
                  值得先看的 {preview.length} 处
                  <span className="preview__note">
                    没有调用模型；完整分析约 {preview.length + 1} 次请求
                  </span>
                </h2>
                <div className="preview__table-wrap">
                  <table className="preview__table">
                    <thead>
                      <tr>
                        <th>位置</th>
                        <th>类型</th>
                        <th>分</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((candidate) => (
                        <tr key={`${candidate.path}:${candidate.line}`}>
                          <td>
                            <code className="inline-code">
                              {candidate.path}:{candidate.line}
                            </code>
                          </td>
                          <td>{candidate.kind}</td>
                          <td>{candidate.score}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="preview__hint">
                  分数是规则命中累加，不是质量评分。要读得懂这些位置在做什么，才需要开始拆解。
                </p>
              </section>
            )}

            <ul className="hints">
              <li>完整分析大约 6–20 次模型请求，成本按你的模型价目表算；「先扫一眼」不走模型。</li>
              <li>报告和证据都留在本机，不出设备。</li>
            </ul>

            {history.length > 0 && (
              <section className="history" aria-label="历史报告">
                <div className="history__head">
                  <h2 className="history__title">之前的报告</h2>
                  <div className="history__tools">
                    <button className="btn btn--ghost btn--sm" type="button" onClick={() => void refreshHistory()}>
                      刷新
                    </button>
                    {history.length > 1 && (
                      <button
                        className="btn btn--ghost btn--sm"
                        type="button"
                        onClick={() => setRunDiffOpen((current) => !current)}
                      >
                        {runDiffOpen ? '收起对比' : '对比两次分析'}
                      </button>
                    )}
                  </div>
                </div>
                <p className="history__lede">
                  每一次拆解都留在本机，点开就是当时生成的那一版，不会因为下次分析被覆盖。
                </p>

                {runDiffOpen && history.length > 1 && (
                  <div className="diffbar diffbar--inline">
                    <span className="diffbar__label">前</span>
                    <Select
                      value={runBefore}
                      options={history.map((item) => ({
                        value: item.runId,
                        label: `${item.title} · ${item.startedAt.slice(0, 10)}`,
                        hint: `${item.points} 点`,
                      }))}
                      onChange={setRunBefore}
                      placeholder="选一次分析"
                      ariaLabel="对比的前一次分析"
                    />
                    <span className="diffbar__label">后</span>
                    <Select
                      value={runAfter}
                      options={history.map((item) => ({
                        value: item.runId,
                        label: `${item.title} · ${item.startedAt.slice(0, 10)}`,
                        hint: `${item.points} 点`,
                      }))}
                      onChange={setRunAfter}
                      placeholder="选一次分析"
                      ariaLabel="对比的后一次分析"
                    />
                    <button className="btn btn--ghost btn--sm" type="button" onClick={() => void openRunDiff()}>
                      对比
                    </button>
                  </div>
                )}

                {history.length > 3 && (
                  <input
                    className="input input--sm history__search"
                    type="search"
                    value={historyQuery}
                    placeholder="按仓库、标题或日期筛选"
                    aria-label="筛选历史报告"
                    onChange={(event) => setHistoryQuery(event.target.value)}
                  />
                )}

                {shownHistory.length === 0 ? (
                  <p className="history__empty">没有匹配的报告。</p>
                ) : (
                  <ul className="history__list">
                    {shownHistory.map((item) => (
                      <li
                        className={`history__row ${item.runId === runId ? 'history__row--current' : ''}`}
                        key={item.runId}
                      >
                        <button
                          type="button"
                          className="history__main"
                          onClick={() =>
                            item.resumable ? void resumeRun(item.runId) : void openReport(item.runId)
                          }
                          disabled={running}
                        >
                          <span className="history__name" title={item.title}>
                            {item.title}
                          </span>
                          <span className="history__meta">
                            {item.status === 'failed'
                              ? `未完成 · 已判 ${item.done} 个候选 · 继续`
                              : `${item.points} 个学习点 · 取证 ${formatRate(item.evidenceRate)} · ${whenText(item.startedAt)}`}
                          </span>
                          <span className="history__open" aria-hidden="true">
                            →
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`history__forget ${forgetting === item.runId ? 'history__forget--armed' : ''}`}
                          onClick={() => void removeStored('run', item.runId)}
                          aria-label={`删除 ${item.title} 的分析`}
                          title="删掉这份分析"
                        >
                          {forgetting === item.runId ? '真的删？' : '×'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </section>
        ) : runDiff !== null ? (
          <>
            <aside className="rail">
              <div className="rail__block">
                <span className="rail__label">模式</span>
                <span className="rail__value">两次分析的对照</span>
              </div>
              <div className="rail__block">
                <span className="rail__label">前</span>
                <span className="rail__value rail__value--mono">{runDiff.before.runId.slice(0, 8)}</span>
              </div>
              <div className="rail__block">
                <span className="rail__label">后</span>
                <span className="rail__value rail__value--mono">{runDiff.after.runId.slice(0, 8)}</span>
              </div>
              <div className="rail__actions">
                <button className="btn btn--ghost btn--sm" type="button" onClick={() => setRunDiff(null)}>
                  退出对比
                </button>
              </div>
            </aside>
            <div className="paper" ref={paperRef}>
              <RunDiffView diff={runDiff} onClose={() => setRunDiff(null)} />
            </div>
          </>
        ) : (
          <>
            <aside className="rail">
              {diffOpen ? (
                <>
                  <div className="rail__block">
                    <span className="rail__label">模式</span>
                    <span className="rail__value">两份应用重建的对照</span>
                  </div>
                  <p className="rail__note">
                    这些数字来自 REA 对两份打包产物的静态重建，不是源码分析。
                  </p>
                  <div className="rail__actions">
                    <button
                      className="btn btn--ghost btn--sm"
                      type="button"
                      onClick={() => {
                        setDiffOpen(false)
                        setMarkdown('')
                      }}
                    >
                      退出对比
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rail__block">
                    <span className="rail__label">仓库</span>
                    <span className="rail__value" title={reportSource || repo}>
                      {reportSource || repo || '—'}
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
                  {usage !== null && (
                    <div className="rail__block">
                      <span className="rail__label">用量</span>
                      <span
                        className="rail__value"
                        title={`输入 ${usage.in} tokens / 输出 ${usage.out} tokens`}
                      >
                        {usage.calls} 次 · {usage.in + usage.out} tokens
                      </span>
                      {price !== null && (
                        <span className="rail__note">
                          按设置价目表：约 {formatUsd(costOfTokens(usage.in, usage.out, price))}
                        </span>
                      )}
                      {usage.stoppedForBudget && (
                        <span className="rail__note">预算到顶，后面的候选没有再判。</span>
                      )}
                    </div>
                  )}
                  <ReportToc
                    items={toc}
                    onJump={(id) => {
                      const target = paperRef.current?.querySelector<HTMLElement>(`#${id}`)
                      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                    }}
                  />
                  <div className="rail__actions">
                    <button
                      className="btn btn--ghost btn--sm"
                      type="button"
                      onClick={() => {
                        setMarkdown('')
                        setRunId('')
                        setReportSource('')
                        setUsage(null)
                        setProgress(null)
                        setDiffOpen(false)
                        setRunDiff(null)
                      }}
                    >
                      再拆一个
                    </button>
                  </div>
                </>
              )}
            </aside>
            <div className="paper" ref={paperRef}>
              {diffOpen && (
                <DiffBar
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
                />
              )}
              <div className="paper__tools">
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => void copyReport()}
                  title="把这份报告复制成 Markdown"
                >
                  {copied ? '已复制' : '复制'}
                </button>
                {runId !== '' && (
                  <button
                    className="btn btn--ghost btn--sm"
                    type="button"
                    onClick={() => void revealReport()}
                    title="在文件管理器里显示 report.md"
                  >
                    在文件夹中显示
                  </button>
                )}
                {runId !== '' && (
                  <label className="export-toggle" title="术语表和 FAQ 需要一次批量模型调用；其余文件是 0 次">
                    <input
                      type="checkbox"
                      checked={enrichExport}
                      disabled={exporting}
                      onChange={(event) => setEnrichExport(event.target.checked)}
                    />
                    术语表 / FAQ（+1 次调用）
                  </label>
                )}
                {runId !== '' && (
                  <button
                    className="btn btn--ghost btn--sm"
                    type="button"
                    disabled={exporting}
                    onClick={() => void exportAll()}
                    title="把这次分析导出成摘要、决策、风险、上手、自测与证据"
                  >
                    {exporting ? '导出中…' : '导出整套产出'}
                  </button>
                )}
              </div>
              {exported !== null && (
                <div className="export" role="status">
                  <span>
                    已导出 {exported.files.length} 个文件 · {exported.modelCalls} 次额外模型调用
                  </span>
                  <code className="export__path">{exported.dir}</code>
                  {exported.enrichError !== undefined && (
                    <span className="export__warn">术语表生成失败：{exported.enrichError}</span>
                  )}
                  <button
                    className="btn btn--ghost btn--sm"
                    type="button"
                    onClick={() => {
                      void api()
                        .report.revealExport(runId)
                        .then((reply) => {
                          if (!reply.ok) setError(reply.message ?? '打不开导出目录。')
                        })
                    }}
                  >
                    在文件夹中显示
                  </button>
                </div>
              )}
              <ReportView markdown={markdown} onCite={runId === '' ? undefined : (file, lines) => void openEvidence(file, lines)} />
              {runId !== '' && (
                <AskPanel
                  key={runId}
                  runId={runId}
                  onCite={(file, lines) => void openEvidence(file, lines)}
                />
              )}
            </div>
          </>
        )}
      </main>

      {evidenceWhere !== '' && (
        <EvidencePanel
          where={evidenceWhere}
          loading={evidenceLoading}
          reply={evidenceReply}
          onClose={() => {
            setEvidenceWhere('')
            setEvidenceReply(null)
          }}
        />
      )}

      {settingsOpen && settings !== null && (
        <SettingsPanel
          settings={settings}
          version={version}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
