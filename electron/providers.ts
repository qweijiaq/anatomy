/**
 * The provider list the settings screen offers.
 *
 * Same set as x-code-cli's catalog — anthropic, openai, deepseek, alibaba, google,
 * xai, zhipu, moonshotai, opencode, opencode-go, opendesign, opendesign-go — because
 * a person who pays for one of these should find it here under the same name.
 *
 * Three things the catalog knows that a flat list does not:
 *
 * - **protocol** is a property of the endpoint, not the brand. Anthropic speaks the
 *   Messages API; Google's `v1beta/openai` path is OpenAI-shaped; everything else is
 *   chat completions. Sending an OpenAI body to Anthropic (or the reverse) is a 404
 *   that reads like a typo.
 * - **regional endpoints** matter: zhipu has China (open.bigmodel.cn) and
 *   International (api.z.ai); Moonshot has `.cn` and `.ai`; Alibaba has China,
 *   Singapore and US. A key issued in one region does not work in another, so the
 *   choice is a field, not a hidden default.
 * - **the gateway plans** (OpenCode Zen / Go, OpenDesign) are prepaid subscriptions
 *   with their own base URLs, not per-token APIs.
 *
 * The model lists are a starting point: every one of these providers accepts ids
 * that are not listed here, so the field stays free text.
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

export type Protocol = 'openai' | 'anthropic' | 'xai'

export type EndpointOption = { label: string; url: string }

export type ProviderPreset = {
  id: ProviderId
  label: string
  /** Blank means "use the protocol's default endpoint". */
  baseUrl: string
  defaultModel: string
  suggestedModels: string[]
  keyUrl: string
  hint: string
  protocol: Protocol
  /** Regional or plan-specific endpoints; picking one swaps `baseUrl`. */
  endpoints?: EndpointOption[]
  /** Local servers need no key. */
  keyless?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: '中文长文本性价比高。分析时会自动关闭思考模式，否则 JSON 会被截断。',
    protocol: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    suggestedModels: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
    keyUrl: 'https://console.anthropic.com/',
    hint: '原生 Messages 协议，自动拼 /messages。',
    protocol: 'anthropic',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: '也可以填任何 OpenAI 兼容网关。',
    protocol: 'openai',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: '走 Google 的 OpenAI 兼容层（/v1beta/openai），Bearer 鉴权。',
    protocol: 'openai',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    suggestedModels: ['grok-4', 'grok-3', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai/',
    hint: 'OpenAI 兼容端点。',
    protocol: 'openai',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    suggestedModels: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    hint: '国内与国际站的 Key 互不通用，先选对你开通的那一个。',
    protocol: 'openai',
    endpoints: [
      { label: '中国站 open.bigmodel.cn', url: 'https://open.bigmodel.cn/api/paas/v4' },
      { label: '国际站 api.z.ai', url: 'https://api.z.ai/api/paas/v4' },
    ],
  },
  {
    id: 'moonshotai',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    suggestedModels: ['moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    hint: '国内站与海外站的 Key 互不通用。',
    protocol: 'openai',
    endpoints: [
      { label: '国内 api.moonshot.cn', url: 'https://api.moonshot.cn/v1' },
      { label: '海外 api.moonshot.ai', url: 'https://api.moonshot.ai/v1' },
    ],
  },
  {
    id: 'alibaba',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    suggestedModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    hint: '按地域选端点；Key 与地域绑定。',
    protocol: 'openai',
    endpoints: [
      { label: '中国 dashscope.aliyuncs.com', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: '新加坡 dashscope-intl', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { label: '美国 dashscope-us', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    suggestedModels: ['anthropic/claude-sonnet-4', 'deepseek/deepseek-chat', 'openai/gpt-4o'],
    keyUrl: 'https://openrouter.ai/keys',
    hint: '一个 Key 访问多家模型；模型 ID 要带厂商前缀。',
    protocol: 'openai',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'kimi-k3',
    suggestedModels: ['kimi-k3', 'qwen3.8-max', 'deepseek-v4-pro', 'glm-5.3'],
    keyUrl: 'https://opencode.ai/console',
    hint: '按量计费的网关。',
    protocol: 'openai',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'kimi-k3',
    suggestedModels: ['kimi-k3', 'claude-haiku-5.5', 'gemini-4-argon', 'gpt-6-luna'],
    keyUrl: 'https://opencode.ai/console',
    hint: '订阅制套餐，端点与 Zen 不同。',
    protocol: 'openai',
  },
  {
    id: 'opendesign',
    label: 'OpenDesign',
    baseUrl: 'https://amr-link.open-design.ai/v1',
    defaultModel: 'deepseek-v4.1-flash',
    suggestedModels: ['deepseek-v4.1-flash'],
    keyUrl: 'https://open-design.ai/cloud/api-keys',
    hint: '自有网关，模型 id 以控制台为准。',
    protocol: 'openai',
  },
  {
    id: 'opendesign-go',
    label: 'OpenDesign Go',
    baseUrl: 'https://amr-link.open-design.ai/v1',
    defaultModel: 'deepseek-v4.1-flash',
    suggestedModels: ['deepseek-v4.1-flash'],
    keyUrl: 'https://open-design.ai/cloud/api-keys',
    hint: 'OpenDesign 的订阅套餐；端点同为 amr-link。',
    protocol: 'openai',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b',
    suggestedModels: ['qwen2.5:7b', 'llama3.1'],
    keyUrl: '',
    hint: '本地推理，代码不出设备。',
    protocol: 'openai',
    keyless: true,
  },
  {
    id: 'lmstudio',
    label: '本地 LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    suggestedModels: [],
    keyUrl: '',
    hint: 'LM Studio 的 OpenAI 兼容端点。',
    protocol: 'openai',
    keyless: true,
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    suggestedModels: [],
    keyUrl: '',
    hint: '任何实现了 /chat/completions 的网关。Base URL 要能直接拼上 /chat/completions。',
    protocol: 'openai',
  },
]

export function presetOf(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS[0]!
}
