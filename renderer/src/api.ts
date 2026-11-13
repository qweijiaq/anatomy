/**
 * The renderer's view of the bridge.
 *
 * The types mirror `electron/preload.ts`. They are declared here rather than
 * imported so the renderer bundle never pulls a Node module; the two files are
 * small enough that keeping them in step is cheaper than a build-time type share.
 */

export type ProviderId =
  | 'deepseek'
  | 'zhipu'
  | 'anthropic'
  | 'openai'
  | 'moonshot'
  | 'alibaba'
  | 'openrouter'
  | 'opencode'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

export type SettingsView = {
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  lang: 'zh' | 'en'
  topN: number
  apiKeyConfigured: boolean
  apiKeyHint: string
  keysNeedReentry: boolean
}

export type SettingsPatch = Partial<{
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic'
  lang: 'zh' | 'en'
  topN: number
  apiKey: string | null
}>

export type TestResult = { ok: boolean; message: string; usage?: { in: number; out: number } }

export type RunResult =
  | { ok: true; runId: string; reportPath: string; markdown: string }
  | { ok: false; message: string }

export type Progress = { phase: string; detail?: string }

type AnaBridge = {
  settings: {
    read(): Promise<SettingsView>
    save(patch: SettingsPatch): Promise<SettingsView>
    test(): Promise<TestResult>
  }
  analysis: {
    run(request: { repo: string; top?: number; lang?: 'zh' | 'en' }): Promise<RunResult>
    onProgress(listener: (progress: Progress) => void): () => void
  }
  report: { read(runId: string): Promise<{ ok: boolean; markdown?: string; message?: string }> }
  app: { info(): Promise<{ version: string; hasKey: boolean }> }
}

declare global {
  interface Window {
    ana: AnaBridge
  }
}

/** Present when the page runs in a plain browser (`vite dev` without Electron). */
export const bridgeAvailable = (): boolean => typeof window !== 'undefined' && 'ana' in window

export const api = (): AnaBridge => window.ana
