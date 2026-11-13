# 桌面应用

`ana` 命令行能干的一切都在这里：填一个仓库地址，跑一次分析，读那份带行号证据的报告。
模型 Key 在应用内配置，加密保存在本机，不经过任何服务器。

## 跑起来

```bash
npm install

npm run build:desktop     # 打包 main / preload / renderer
npm run start:desktop     # 打开窗口

# 开发时热更新（两个终端）
npm run dev:renderer      # vite，127.0.0.1:5199
npm run dev:desktop       # 另一个终端：窗口连到上面那个地址
```

第一次打开会自动弹设置页——没有 Key 的话，主页面只会有一个必定失败的按钮。

## Key 怎么存

- 走 Electron `safeStorage`（macOS 上用 Keychain）加密，落到
  `~/Library/Application Support/anatomy/settings.json`。
- 系统不支持加密时降级为明文，文件权限 `0600`。
- 渲染进程**永远拿不到 Key**：它只收到 `apiKeyConfigured` 和 `••••abcd` 这样的提示。
  "测试连接"也在主进程里发请求。
- 换机器之后旧 Key 解不开，设置页会提示重新填写，而不是静默失败。

## 支持的 provider

与 reading-notes 同一套预设：DeepSeek、智谱 GLM、Anthropic Claude、OpenAI、Moonshot、
阿里云百炼、OpenRouter、OpenCode Zen、本地 Ollama / LM Studio，以及自定义 OpenAI 兼容网关。

两处实现细节值得知道：

- **协议是按 provider 分的，不只是 base URL。** Anthropic 用原生 Messages API
  （`/messages`、`x-api-key`、system 是顶层字段、没有 `response_format`），
  其余走 OpenAI 兼容的 `/chat/completions`。选错协议会得到一个看起来像地址写错的 404。
- **DeepSeek 会自动关闭思考模式。** 它的 V4 默认把预算花在 reasoning 上，JSON 会被截断；
  只有 DeepSeek 的模型会被加上 `thinking: {type: 'disabled'}`。

## 代码在哪

```
electron/providers.ts   预设列表（id / endpoint / 协议 / 默认模型）
electron/settings.ts    safeStorage 读写，渲染进程只能看到脱敏后的视图
electron/main.ts        窗口 + 三个 IPC 面（settings / analysis / report）
electron/preload.ts     contextBridge，固定 API，不暴露 ipcRenderer
renderer/src/           React 界面：设置页、主页面、报告渲染
scripts/build-electron.mjs  esbuild 打包 main 与 preload，并复制 Python sidecar
```

主进程直接调用 `src/commands/analyze.ts` 与 `src/render/markdown.ts`——**不是重写，
是同一份实现**，所以窗口里读到的报告和 `report.md` 逐字相同。

## 一个环境坑

本仓库在 agent shell 里运行时，环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成
纯 Node 进程：`require('electron')` 返回二进制路径字符串，`app` 是 `undefined`，窗口打不开。
`run-electron.mjs` 启动前把它删掉。自己手动跑的话记得 `env -u ELECTRON_RUN_AS_NODE`。

## 还没做

- 只做完整分析，没有"先 scan 看看"那一步（命令行有：`ana scan`）
- 没有逐条证据的 `ana inspect` 交互
- 没有历史 run 列表，关掉窗口后要重新跑
- 没有打包成 .app / .dmg（`electron-builder` 未接入）
