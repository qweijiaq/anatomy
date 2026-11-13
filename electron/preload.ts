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
    onProgress: (listener: (progress: { phase: string; detail?: string }) => void) => {
      const handler = (_event: unknown, progress: { phase: string; detail?: string }) =>
        listener(progress)
      ipcRenderer.on('analysis:progress', handler)
      return () => ipcRenderer.removeListener('analysis:progress', handler)
    },
  },
  report: {
    read: (runId: string) => ipcRenderer.invoke('report:read', runId),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
}

contextBridge.exposeInMainWorld('ana', api)

export type AnaApi = typeof api
