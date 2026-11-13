/**
 * The renderer's view of the bridge.
 *
 * The types mirror `electron/preload.ts`. They are declared here rather than
 * imported so the renderer bundle never pulls a Node module; the two files are
 * small enough that keeping them in step is cheaper than a build-time type share.
 */

export type ProviderId =
  | 'deepseek'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'zhipu'
  | 'moonshotai'
  | 'alibaba'
  | 'openrouter'
  | 'opencode'
  | 'opencode-go'
  | 'opendesign'
  | 'opendesign-go'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

export type SettingsView = {
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic' | 'xai'
  lang: 'zh' | 'en'
  topN: number
  reportPoints: number
  apiKeyConfigured: boolean
  apiKeyHint: string
  keysNeedReentry: boolean
}

export type SettingsPatch = Partial<{
  reportPoints: number
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: 'openai' | 'anthropic' | 'xai'
  lang: 'zh' | 'en'
  topN: number
  apiKey: string | null
}>

export type TestResult = { ok: boolean; message: string; usage?: { in: number; out: number } }

export type RunResult =
  | { ok: true; runId: string; reportPath: string; markdown: string }
  | { ok: false; message: string }

/** One application reconstructed by REA — the shape `ana inspect-app` writes. */
export type AppSurvey = {
  /** 目录名，用来说明「哪一份」。 */
  dirName?: string
  evidenceId: string
  confidence: string
  authority: string
  target: string
  name: string
  format: string
  digest: string
  surface: {
    browserWindows: number
    preloadEntrypoints: number
    contextBridgeApis: number
    exposedApiMembers: number
    ipcOperations: number
    ipcLiteralChannels: number
    ipcMainHandlers: number
    rendererTransmissions: number
    rendererListeners: number
    ambiguousTransmissions: number
    senderValidationObservations: number
    nativeAddonBindings: number
    protocolRegistrations: number
    semantics: string
  }
  statistics: {
    relevantFiles: number
    parsedJavaScriptFiles: number
    visitedAstNodes: number
    findings: number
    textBytesRead: number
    parseFailures: number
  }
  limitations: string[]
  modules: Array<{
    id: string
    kind: string
    label: string
    artifact: string
    labels: string[]
    members: string[]
    operation: string
  }>
  relations: Array<{ from: string; to: string; relation: string }>
  groups: {
    channels: Record<'privileged' | 'write' | 'read' | 'event' | 'other', string[]>
    members: Record<'privileged' | 'write' | 'read' | 'event' | 'other', string[]>
  }
  pairs: Array<{ name: string; operation: string; handled: boolean }>
  graphOmitted: string
  retried: boolean
  retryNote: string
  evidenceFile: string
}

export type Progress = {
  phase: string
  detail?: string
  /** Set on the stages that take one model call per item. */
  done?: number
  total?: number
}

/** One finished run on disk, as the history rail shows it. */
export type ReportSummary = {
  runId: string
  source: string
  startedAt: string
  points: number
  title: string
}

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
  report: {
    read(runId: string): Promise<{ ok: boolean; markdown?: string; message?: string }>
    list(): Promise<{ ok: boolean; runs: ReportSummary[] }>
    forget(kind: 'run' | 'app', id: string): Promise<{ ok: boolean; message?: string }>
  }
  models: {
    list(): Promise<{ ok: boolean; models?: Array<{ id: string; ownedBy?: string }>; message?: string }>
  }
  surveys: {
    list(): Promise<{ ok: boolean; surveys?: AppSurvey[]; message?: string }>
    diff(before: string, after: string): Promise<{ ok: boolean; markdown?: string; message?: string }>
  }
  app: {
    info(): Promise<{ version: string; hasKey: boolean }>
    pickFolder(): Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  }
}

declare global {
  interface Window {
    ana: AnaBridge
  }
}

/** Present when the page runs in a plain browser (`vite dev` without Electron). */
export const bridgeAvailable = (): boolean => typeof window !== 'undefined' && 'ana' in window

export const api = (): AnaBridge => window.ana
