/**
 * Where the key lives, and how it gets out again.
 *
 * Two rules, both learned from the reading-notes project:
 *
 * - The key is encrypted at rest with Electron's `safeStorage` when the platform
 *   can do it, and stored as plain text only when it cannot. The stored record
 *   always carries a `hint` (`••••abcd`) so the settings screen can show *which*
 *   key is configured without ever putting the key itself into the renderer.
 * - The renderer never receives the key. It receives a boolean and the hint; a
 *   "test connection" tick goes through the main process, which is also the only
 *   place that builds a model client.
 *
 * The file is `<userData>/settings.json`, next to the app's other state.
 */

import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import type { Protocol, ProviderId } from './providers.js'
import { presetOf } from './providers.js'

export type StoredKey = { enc?: string; plain?: string; hint: string }

export type Settings = {
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: Protocol
  lang: 'zh' | 'en'
  topN: number
  /** How many verified points the report's top list may hold. */
  reportPoints: number
  keys: Partial<Record<ProviderId, StoredKey>>
  lastRepos: string[]
}

const DEFAULTS: Settings = {
  provider: 'deepseek',
  baseUrl: presetOf('deepseek').baseUrl,
  model: presetOf('deepseek').defaultModel,
  protocol: 'openai',
  lang: 'zh',
  // Twelve candidates, six reported. Eight and five was the old shape: the scan
  // collected barely more than the report could show, so a good candidate set had
  // nothing to cut and the report read as thin.
  topN: 12,
  reportPoints: 6,
  keys: {},
  lastRepos: [],
}

/** What the settings screen is allowed to see. */
export type SettingsView = {
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: Protocol
  lang: 'zh' | 'en'
  topN: number
  reportPoints: number
  apiKeyConfigured: boolean
  apiKeyHint: string
  keysNeedReentry: boolean
}

let cache: Settings | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read once, then keep in memory: the file is tiny and every screen asks for it.
 *
 * A malformed file must not take the app down — a person whose settings got
 * truncated needs the window to open so they can fix it. The defaults are
 * returned instead, and the next save rewrites the file.
 */
export function settings(): Settings {
  if (cache !== null) return cache
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    parsed = null
  }
  if (!isRecord(parsed)) {
    cache = { ...DEFAULTS }
    return cache
  }
  const preset = presetOf((parsed['provider'] as ProviderId) ?? DEFAULTS.provider)
  cache = {
    provider: preset.id,
    baseUrl: typeof parsed['baseUrl'] === 'string' ? parsed['baseUrl'] : preset.baseUrl,
    model: typeof parsed['model'] === 'string' ? parsed['model'] : preset.defaultModel,
    protocol: parsed['protocol'] === 'anthropic' ? 'anthropic' : preset.protocol,
    lang: parsed['lang'] === 'en' ? 'en' : 'zh',
    topN: typeof parsed['topN'] === 'number' && parsed['topN'] > 0 ? parsed['topN'] : DEFAULTS.topN,
    // Clamped rather than rejected: a hand-edited file with 200 here would ask the
    // model for a two-hundred-item list and then throw most of it away.
    reportPoints:
      typeof parsed['reportPoints'] === 'number' &&
      parsed['reportPoints'] >= 1 &&
      parsed['reportPoints'] <= 12
        ? Math.floor(parsed['reportPoints'])
        : DEFAULTS.reportPoints,
    keys: isRecord(parsed['keys']) ? (parsed['keys'] as Settings['keys']) : {},
    lastRepos: Array.isArray(parsed['lastRepos'])
      ? (parsed['lastRepos'] as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
  }
  return cache
}

function persist(): void {
  if (cache === null) return
  const dir = path.dirname(file())
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A settings write that fails must not kill the app; the in-memory copy stays
    // correct for this session and the next save retries.
  }
}

function hintOf(apiKey: string): string {
  return apiKey.length <= 8 ? '••••' : `••••${apiKey.slice(-4)}`
}

function encodeKey(apiKey: string): StoredKey {
  const hint = hintOf(apiKey)
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(apiKey).toString('base64'), hint }
  }
  return { plain: apiKey, hint }
}

/**
 * The key for a provider, or null.
 *
 * A record encrypted on another machine (or after the keychain changed) cannot be
 * decrypted here; that is reported as "needs re-entry" rather than crashing.
 */
export function readKey(provider: ProviderId): string | null {
  const stored = settings().keys[provider]
  if (stored === undefined) return null
  if (typeof stored.enc === 'string') {
    try {
      return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'))
    } catch {
      return null
    }
  }
  if (typeof stored.plain === 'string') return stored.plain
  return null
}

function anyKeyNeedsReentry(): boolean {
  const current = settings()
  return (Object.keys(current.keys) as ProviderId[]).some((provider) => {
    const stored = current.keys[provider]
    return stored !== undefined && typeof stored.enc === 'string' && readKey(provider) === null
  })
}

export function getSettingsView(): SettingsView {
  const current = settings()
  const preset = presetOf(current.provider)
  const stored = current.keys[current.provider]
  const configured = preset.keyless === true || readKey(current.provider) !== null
  return {
    provider: current.provider,
    baseUrl: current.baseUrl,
    model: current.model,
    protocol: current.protocol,
    lang: current.lang,
    topN: current.topN,
    reportPoints: current.reportPoints,
    apiKeyConfigured: configured,
    apiKeyHint: configured ? (stored?.hint ?? (preset.keyless === true ? '本地，无需 Key' : '')) : '',
    keysNeedReentry: anyKeyNeedsReentry(),
  }
}

export type SettingsPatch = {
  provider?: ProviderId
  baseUrl?: string
  model?: string
  protocol?: Protocol
  lang?: 'zh' | 'en'
  topN?: number
  reportPoints?: number
  /** An empty string keeps the existing key; `null` clears it. */
  apiKey?: string | null
}

export function saveSettings(patch: SettingsPatch): SettingsView {
  const current = settings()

  if (patch.provider !== undefined && patch.provider !== current.provider) {
    // Switching provider swaps in that provider's endpoint and model, unless the
    // caller sent its own values in the same save (the screen does).
    const preset = presetOf(patch.provider)
    current.provider = preset.id
    current.baseUrl = preset.baseUrl
    current.model = preset.defaultModel
    current.protocol = preset.protocol
  }
  if (patch.baseUrl !== undefined) current.baseUrl = patch.baseUrl.trim()
  if (patch.model !== undefined) current.model = patch.model.trim()
  if (patch.protocol !== undefined) current.protocol = patch.protocol
  if (patch.lang !== undefined) current.lang = patch.lang === 'en' ? 'en' : 'zh'
  if (patch.topN !== undefined && Number.isFinite(patch.topN)) {
    current.topN = Math.max(1, Math.min(50, Math.floor(patch.topN)))
  }
  if (patch.reportPoints !== undefined && Number.isFinite(patch.reportPoints)) {
    current.reportPoints = Math.max(1, Math.min(12, Math.floor(patch.reportPoints)))
  }

  if (patch.apiKey === null) {
    delete current.keys[current.provider]
  } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
    current.keys[current.provider] = encodeKey(patch.apiKey.trim())
  }

  persist()
  return getSettingsView()
}

export function rememberRepo(repo: string): void {
  const current = settings()
  const trimmed = repo.trim()
  if (trimmed === '') return
  current.lastRepos = [trimmed, ...current.lastRepos.filter((item) => item !== trimmed)].slice(0, 8)
  persist()
}

/** Used by the "test connection" tick and by the analysis run. */
export function activeModelConfig(): {
  provider: ProviderId
  baseUrl: string
  model: string
  protocol: Protocol
  apiKey: string
} {
  const current = settings()
  const preset = presetOf(current.provider)
  return {
    provider: current.provider,
    baseUrl: current.baseUrl.trim() !== '' ? current.baseUrl.trim() : preset.baseUrl,
    model: current.model.trim() !== '' ? current.model.trim() : preset.defaultModel,
    protocol: current.protocol,
    apiKey: readKey(current.provider) ?? (preset.keyless === true ? 'local' : ''),
  }
}
