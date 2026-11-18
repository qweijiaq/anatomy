/**
 * The only bridge between the window and the main process.
 *
 * `contextBridge` exposes a fixed API — no `ipcRenderer`, no `require` — so a
 * compromised renderer cannot reach the disk, the network or a stored key. The
 * key never crosses this boundary in either direction: the renderer sends text
 * the user typed, and receives a boolean plus a hint.
 */

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    save: (patch: unknown) => ipcRenderer.invoke('settings:save', patch),
    test: () => ipcRenderer.invoke('settings:test'),
  },
  analysis: {
    run: (request: unknown) => ipcRenderer.invoke('analysis:run', request),
    // 断点续跑：读旧 run 的 judge 检查点，复用已判的候选。
    resume: (runId: string) => ipcRenderer.invoke('analysis:resume', runId),
    // 零 token 的预扫：只看哪里值得看，不花钱。
    scan: (repo: string, top?: number) => ipcRenderer.invoke('analysis:scan', { repo, top }),
    onProgress: (
      listener: (progress: {
        phase: string
        detail?: string
        done?: number
        total?: number
      }) => void,
    ) => {
      const handler = (
        _event: unknown,
        progress: { phase: string; detail?: string; done?: number; total?: number },
      ) => listener(progress)
      ipcRenderer.on('analysis:progress', handler)
      return () => ipcRenderer.removeListener('analysis:progress', handler)
    },
  },
  report: {
    read: (runId: string) => ipcRenderer.invoke('report:read', runId),
    // 追问：只根据这次分析已存的证据回答，会花一次模型请求。
    ask: (runId: string, question: string) => ipcRenderer.invoke('report:ask', runId, question),
    // 整套产出：默认 0 次额外模型调用。
    export: (runId: string) => ipcRenderer.invoke('report:export', runId),
    revealExport: (runId: string) => ipcRenderer.invoke('report:revealExport', runId),
    // 一条引用的原文片段：来自这次分析已存的证据，不回头读源码树。
    evidence: (runId: string, file: string, start: number, end: number) =>
      ipcRenderer.invoke('report:evidence', runId, file, start, end),
    // 两次源码分析的结构化对照：点数、取证率、候选、标题增删。
    diff: (before: string, after: string) => ipcRenderer.invoke('report:diff', before, after),
    // 删除一份存下来的分析：id 而不是路径，主进程在同一处校验。
    forget: (kind: 'run' | 'app', id: string) => ipcRenderer.invoke('runs:forget', kind, id),
    // 在文件管理器里显示这份报告：它是磁盘上的一个文件，不只是窗口里的一页。
    reveal: (runId: string) => ipcRenderer.invoke('report:reveal', runId),
    // 历史报告：磁盘上每一个跑完的 run，最新的在前。
    list: () => ipcRenderer.invoke('runs:list'),
  },
  models: {
    // 问端点要它能提供的模型，比内置一份会过期的列表可靠。
    list: () => ipcRenderer.invoke('models:list'),
  },
  surveys: {
    // 已经重建过的应用。生成走 CLI 的 inspect-app，界面只负责看。
    list: () => ipcRenderer.invoke('surveys:list'),
    // 两份之间的差异，主进程算，和 CLI 用同一个渲染器。
    diff: (before: string, after: string) => ipcRenderer.invoke('surveys:diff', before, after),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    // 目录选择：只回传路径，不让渲染进程接触文件系统本身。
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  },
}

contextBridge.exposeInMainWorld('ana', api)

export type AnaApi = typeof api
