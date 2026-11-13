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
    // 历史报告：磁盘上每一个跑完的 run，最新的在前。
    list: () => ipcRenderer.invoke('runs:list'),
  },
  models: {
    // 问端点要它能提供的模型，比内置一份会过期的列表可靠。
    list: () => ipcRenderer.invoke('models:list'),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    // 目录选择：只回传路径，不让渲染进程接触文件系统本身。
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  },
}

contextBridge.exposeInMainWorld('ana', api)

export type AnaApi = typeof api
