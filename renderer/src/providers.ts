/**
 * Provider presets, as the settings screen shows them.
 *
 * A copy of `electron/providers.ts` rather than an import: the main process file
 * is bundled for Node and the renderer must not pull Node code. The list is data,
 * not logic, so the duplication is cheap and a mismatch is immediately visible
 * (a wrong base URL fails the "test connection" tick).
 */

import type { ProviderId } from './api.js'

export type ProviderPreset = {
  id: ProviderId
  label: string
  baseUrl: string
  defaultModel: string
  suggestedModels: string[]
  keyUrl: string
  hint: string
  protocol: 'openai' | 'anthropic'
  keyless?: boolean
}

export const PROVIDERS: ProviderPreset[] = [
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
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
    suggestedModels: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    hint: 'Key 在 bigmodel.cn 的业务空间管理页创建。',
    protocol: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    suggestedModels: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
    keyUrl: 'https://platform.claude.com/settings/keys',
    hint: '用原生 Messages 协议，不需要额外路径。',
    protocol: 'anthropic',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: '也可以填任何 OpenAI 兼容网关；模型 ID 以控制台为准。',
    protocol: 'openai',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    suggestedModels: ['moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    hint: '中文长文友好；128k 版本适合大文件。',
    protocol: 'openai',
  },
  {
    id: 'alibaba',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    suggestedModels: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyUrl: 'https://bailian.console.aliyun.com/',
    hint: '北京地域的兼容模式地址。',
    protocol: 'openai',
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
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    defaultModel: 'qwen3.8-flash',
    suggestedModels: ['qwen3.8-flash', 'gpt-6.1-sol', 'claude-opus-4-6'],
    keyUrl: 'https://opencode.ai/auth',
    hint: '按量计费网关。',
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

export function providerOf(id: ProviderId): ProviderPreset {
  return PROVIDERS.find((preset) => preset.id === id) ?? PROVIDERS[0]!
}
