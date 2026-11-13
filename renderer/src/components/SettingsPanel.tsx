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
import { Select } from './Select.js'

type Props = {
  settings: SettingsView
  onChange: (next: SettingsView) => void
  onClose: () => void
}

/**
 * How much work one analysis does, as three named choices rather than two numbers.
 *
 * `candidates` is how many places the scan collects, `points` how many the report
 * writes up. They are coupled on purpose: asking for ten points while collecting
 * six guarantees five or six, which reads as a thin report and looks like a model
 * problem rather than a settings one. Every extra candidate is one more model call,
 * so the cost is stated in the label rather than hidden.
 */
const DEPTHS = [
  { id: 'quick', label: '精简 · 快', candidates: 6, points: 4, hint: '约 6 次请求' },
  { id: 'standard', label: '标准', candidates: 12, points: 6, hint: '约 12 次请求' },
  { id: 'deep', label: '深入 · 全', candidates: 20, points: 10, hint: '约 20 次请求' },
] as const

/** Which preset the stored numbers correspond to; anything else reads as standard. */
function depthOf(candidates: number, points: number): string {
  const exact = DEPTHS.find((item) => item.candidates === candidates && item.points === points)
  return exact?.id ?? 'standard'
}

export function SettingsPanel({ settings, onChange, onClose }: Props): React.JSX.Element {
  const [provider, setProvider] = useState<ProviderId>(settings.provider)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [saved, setSaved] = useState(false)
  // 端点能提供的模型。空表示还没问过、或者这个端点不实现 /models。
  // 深度：一次问多少个候选点、报告写几条。两个数字必须一起改——候选少于要点时，
  // 报告只能变短，用户看到的就是"内容偏少"。
  const [depth, setDepth] = useState(() => depthOf(settings.topN, settings.reportPoints))
  const [discovered, setDiscovered] = useState<Array<{ id: string; ownedBy?: string }>>([])
  const [discovering, setDiscovering] = useState(false)
  const [discoverNote, setDiscoverNote] = useState('')

  const preset = providerOf(provider)
  const depthPreset = DEPTHS.find((item) => item.id === depth) ?? DEPTHS[1]!
  const topN = depthPreset.candidates
  const reportPoints = depthPreset.points

  // Switching provider resets the derived fields to that provider's defaults; the
  // key field stays empty so the stored key is never overwritten by accident.
  useEffect(() => {
    if (provider === settings.provider) return
    const next = providerOf(provider)
    setBaseUrl(next.endpoints?.[0]?.url ?? next.baseUrl)
    setModel(next.defaultModel)
    setApiKey('')
    setResult(null)
    // 上一家的模型列表对新端点没有意义。
    setDiscovered([])
    setDiscoverNote('')
  }, [provider, settings.provider])

  /** 问端点要模型列表。要先把 Key 存下去，否则主进程手里没有凭证。 */
  async function discover(): Promise<void> {
    setDiscovering(true)
    setDiscoverNote('')
    try {
      if (apiKey.trim() !== '' || baseUrl !== settings.baseUrl || provider !== settings.provider) {
        await save()
      }
      const reply = await api().models.list()
      if (reply.ok && Array.isArray(reply.models)) {
        setDiscovered(reply.models)
        setDiscoverNote(
          reply.models.length === 0
            ? '端点没有返回任何模型，可以手填 ID。'
            : `找到 ${reply.models.length} 个模型。`,
        )
      } else {
        setDiscoverNote(reply.message ?? '拿不到模型列表，可以手填 ID。')
      }
    } catch (failure) {
      setDiscoverNote(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setDiscovering(false)
    }
  }

  async function save(extra?: { apiKey?: string | null }): Promise<void> {
    const next = await api().settings.save({
      provider,
      baseUrl,
      model,
      protocol: preset.protocol,
      apiKey: extra?.apiKey ?? (apiKey.trim() !== '' ? apiKey.trim() : undefined),
      lang: settings.lang,
      topN,
      reportPoints,
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
          <Select
            id="provider"
            value={provider}
            onChange={(next) => setProvider(next as ProviderId)}
            options={PROVIDERS.map((item) => ({
              value: item.id,
              label: item.label,
              hint: item.keyless === true ? '本地' : undefined,
            }))}
          />
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
          {discovered.length > 0 ? (
            <Select
              id="model"
              value={model}
              onChange={setModel}
              options={discovered.map((item) => ({
                value: item.id,
                label: item.id,
                hint: item.ownedBy,
              }))}
            />
          ) : (
            <input
              id="model"
              className="input input--mono"
              spellCheck={false}
              placeholder={preset.defaultModel || '模型 ID'}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          )}

          <div className="model-actions">
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => void discover()}
              disabled={discovering}
            >
              {discovering ? '正在问端点…' : '获取可用模型'}
            </button>
            {discovered.length > 0 && (
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                onClick={() => {
                  setDiscovered([])
                  setDiscoverNote('')
                }}
              >
                改为手填
              </button>
            )}
            {discoverNote !== '' && <span className="model-actions__note">{discoverNote}</span>}
          </div>

          {preset.suggestedModels.length > 0 && discovered.length === 0 && (
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

        <section className="field">
          <label className="field__label" htmlFor="depth">
            报告深度
          </label>
          <Select
            id="depth"
            value={depth}
            onChange={setDepth}
            options={DEPTHS.map((item) => ({
              value: item.id,
              label: item.label,
              hint: item.hint,
            }))}
          />
          <p className="field__hint">
            一次分析会问 {topN} 个候选点，报告写 {reportPoints} 条。候选点少于要写的条数，
            报告就只能变短；每多一个候选点，多一次模型请求。
          </p>
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
