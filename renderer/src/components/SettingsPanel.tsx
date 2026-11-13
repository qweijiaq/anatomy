/**
 * Provider settings: pick a preset, fill the key, prove it works.
 *
 * The screen is a single column because the decision is a single one — "which
 * model am I paying for". Everything that follows from that choice (endpoint,
 * protocol, model list) is derived and visible, so a person can see why a request
 * would fail before it fails.
 *
 * A saved key is shown only as `••••abcd`. Typing a new one replaces it; clearing
 * the field keeps the old one, because losing a key by tabbing past a field is a
 * bad way to learn that a form auto-saves.
 */

import { useEffect, useState } from 'react'

import { api, type ProviderId, type SettingsView, type TestResult } from '../api.js'
import { PROVIDERS, providerOf } from '../providers.js'

type Props = {
  settings: SettingsView
  onChange: (next: SettingsView) => void
  onClose: () => void
}

export function SettingsPanel({ settings, onChange, onClose }: Props): React.JSX.Element {
  const [provider, setProvider] = useState<ProviderId>(settings.provider)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [saved, setSaved] = useState(false)

  const preset = providerOf(provider)

  // Switching provider resets the derived fields to that provider's defaults; the
  // key field stays empty so the stored key is never overwritten by accident.
  useEffect(() => {
    if (provider === settings.provider) return
    const next = providerOf(provider)
    setBaseUrl(next.endpoints?.[0]?.url ?? next.baseUrl)
    setModel(next.defaultModel)
    setApiKey('')
    setResult(null)
  }, [provider, settings.provider])

  async function save(extra?: { apiKey?: string | null }): Promise<void> {
    const next = await api().settings.save({
      provider,
      baseUrl,
      model,
      protocol: preset.protocol,
      apiKey: extra?.apiKey ?? (apiKey.trim() !== '' ? apiKey.trim() : undefined),
      lang: settings.lang,
      topN: settings.topN,
    })
    onChange(next)
    setApiKey('')
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1800)
  }

  async function test(): Promise<void> {
    setTesting(true)
    setResult(null)
    // Save first: the main process tests what is stored, not what is on screen.
    await save()
    try {
      setResult(await api().settings.test())
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="模型设置">
      <div className="sheet__body">
        <header className="sheet__head">
          <div>
            <h1 className="sheet__title">模型设置</h1>
            <p className="sheet__sub">
              分析用的 token 全部由你自己付。Key 加密保存在本机，不会进入报告，也不会发给我们。
            </p>
          </div>
          <button className="btn btn--ghost" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <section className="field">
          <label className="field__label" htmlFor="provider">
            服务商
          </label>
          <select
            id="provider"
            className="input"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
          >
            {PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <p className="field__hint">
            {preset.hint}
            {preset.keyUrl !== '' && (
              <>
                {' '}
                <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                  获取 Key
                </a>
              </>
            )}
          </p>
        </section>

        <section className="field">
          <label className="field__label" htmlFor="apiKey">
            API Key
            {settings.apiKeyConfigured && settings.provider === provider && (
              <span className="badge badge--ok">已配置 {settings.apiKeyHint}</span>
            )}
          </label>
          <input
            id="apiKey"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={preset.keyless === true ? '本地模型无需 Key' : 'sk-…'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p className="field__hint">
            留空表示沿用已保存的 Key。
            {settings.keysNeedReentry && ' 有的 Key 已无法解密（可能换过机器），请重新填写。'}
          </p>
        </section>

        <section className="field">
          <label className="field__label" htmlFor="baseUrl">
            Base URL
          </label>
          <input
            id="baseUrl"
            className="input input--mono"
            spellCheck={false}
            placeholder={preset.baseUrl || 'https://…/v1'}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          {preset.endpoints !== undefined && preset.endpoints.length > 0 && (
            <div className="chips chips--endpoints" role="group" aria-label="端点">
              {preset.endpoints.map((endpoint) => (
                <button
                  key={endpoint.url}
                  type="button"
                  className={`chip ${endpoint.url === baseUrl ? 'chip--on' : ''}`}
                  onClick={() => setBaseUrl(endpoint.url)}
                  title={endpoint.url}
                >
                  {endpoint.label}
                </button>
              ))}
            </div>
          )}
          <p className="field__hint">
            协议：{preset.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}
            {preset.protocol === 'anthropic' ? '（自动拼 /messages）' : '（自动拼 /chat/completions）'}
            {preset.endpoints !== undefined && ' · 换了地域要选对应的端点，Key 与地域绑定。'}
          </p>
        </section>

        <section className="field">
          <label className="field__label" htmlFor="model">
            模型
          </label>
          <input
            id="model"
            className="input input--mono"
            spellCheck={false}
            list="model-suggestions"
            placeholder={preset.defaultModel || '模型 ID'}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id="model-suggestions">
            {preset.suggestedModels.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          {preset.suggestedModels.length > 0 && (
            <div className="chips chips--models" role="group" aria-label="常用模型">
              {preset.suggestedModels.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`chip ${item === model ? 'chip--on' : ''}`}
                  onClick={() => setModel(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </section>

        {result !== null && (
          <p className={`notice ${result.ok ? 'notice--ok' : 'notice--error'}`}>{result.message}</p>
        )}

        <footer className="sheet__foot">
          <button className="btn btn--ghost" type="button" onClick={() => void test()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <div className="sheet__foot-right">
            {settings.apiKeyConfigured && (
              <button
                className="btn btn--danger-ghost"
                type="button"
                onClick={() => {
                  void save({ apiKey: null })
                }}
              >
                删除已存的 Key
              </button>
            )}
            <button className="btn btn--primary" type="button" onClick={() => void save()}>
              {saved ? '已保存' : '保存'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
