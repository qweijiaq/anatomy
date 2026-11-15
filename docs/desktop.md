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

与 x-code-cli 的 provider 目录同构，16 个：

| 名称 | 协议 | 端点 |
|---|---|---|
| DeepSeek | OpenAI | api.deepseek.com |
| Anthropic Claude | **Messages** | api.anthropic.com |
| OpenAI | OpenAI | api.openai.com |
| Google Gemini | OpenAI | generativelanguage.googleapis.com/v1beta/openai |
| xAI Grok | OpenAI | api.x.ai |
| 智谱 GLM | OpenAI | 中国站 / 国际站 **两选一** |
| Moonshot Kimi | OpenAI | 国内 / 海外 **两选一** |
| 阿里云百炼 | OpenAI | 中国 / 新加坡 / 美国 **三选一** |
| OpenRouter | OpenAI | openrouter.ai |
| OpenCode Zen | OpenAI | opencode.ai/zen/v1 |
| OpenCode Go | OpenAI | opencode.ai/zen/go/v1 |
| OpenDesign / Go | OpenAI | amr-link.open-design.ai |
| 本地 Ollama / LM Studio | OpenAI | localhost |
| 自定义 | OpenAI | 任意兼容网关 |

区域端点做成**可点的选项**而不是隐藏默认值：Key 与地域绑定，选错了会得到一个像
"Key 无效"的错误，而实际上是省份选错了。

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
electron/main.ts        窗口 + 五个 IPC 面（settings / analysis / report / models / surveys）
electron/preload.ts     contextBridge，固定 API，不暴露 ipcRenderer
renderer/src/           React 界面：设置页、主页面、报告渲染、应用重建视图
scripts/build-electron.mjs  esbuild 打包 main 与 preload，并复制 Python sidecar
```

主进程直接调用 `src/commands/analyze.ts` 与 `src/render/markdown.ts`——**不是重写，
是同一份实现**，所以窗口里读到的报告和 `report.md` 逐字相同。

## 一个环境坑

本仓库在 agent shell 里运行时，环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成
纯 Node 进程：`require('electron')` 返回二进制路径字符串，`app` 是 `undefined`，窗口打不开。
`run-electron.mjs` 启动前把它删掉。自己手动跑的话记得 `env -u ELECTRON_RUN_AS_NODE`。

## 界面上有什么

顶栏三个入口：

```
[对比]  [应用 · N]  [provider · model]
```

- **先扫一眼**：主页面上的第二个按钮。零 token、不调模型，只列出「值得先看的 12 处」
  与它们的分数。绝大多数时候人打开一个陌生仓库想先知道哪里有料，而不是先付一次完整
  分析的钱。结果写进 `.ana/scratch` 并覆盖，不像完整分析那样每次留一份记录。
- **报告**：跑完一次分析后直接显示。顶上两个动作——**复制**把 Markdown 放进剪贴板，
  **在文件夹中显示**定位到 `.ana/runs/<id>/report.md`。报告不只是窗口里的一页，它是
  磁盘上的一个文件；想把它贴进 issue 或者放到代码旁边看，原本只能自己去翻目录。页面和
  `report.md` 逐字相同——同一份渲染器。
- **历史**：首页底部列出 `.ana/runs` 里所有跑完的 run，点开就是当时那一版；行尾的 `×`
  两段确认后删除（`ana forget` 的图形版）。
- **应用 · N**：`ana inspect-app` 重建过的应用。页头可切换看哪一份，`删除`同样两段确认。
  内容分三块：Electron 暴露面、contextBridge 暴露的每个成员、IPC 通道按名字分级。
- **对比**：挑两份 survey 算差异，吸顶选择条，改前/后不用滚回顶部。

窗口**会跑分析**：选目录、填地址，它做的事和 `ana analyze` 完全一样，进度一条条推上来
（取证 → 判读 → 排序 → 综述）。它**不跑**的是应用重建（`ana inspect-app`）——那一段是
几分钟的 REA 计算，没有可汇报的进度，所以留给 CLI，窗口只读它留下的 survey。除了这一块，
界面上的每次点击都是即时的：报告、历史、对比全部读磁盘上已有的结果。

## 还没做

- 没有逐条证据的 `ana inspect` 交互
- **分析开始后不能取消**。窗口只显示进度；要停下就关掉窗口。这不是疏忽：一次分析
  是一串模型调用，中途取消要把它传进每一层（`AbortSignal`），而它现在的价值不如把
  那件事做对。长任务用的是 CLI，那里的 Ctrl-C 本来就能用。
- 没有打包成 .dmg 分发（`electron-builder` 未接入）。本地要一个能双击的 app 用
  `npm run build:desktop && npm run build:bundle`，产物在 `out/anatomy.app`（约 233MB，
  Electron 运行时加 `dist-electron` / `dist-renderer` 的副本，已在 .gitignore 里）。
  `npm run clean` 可以清掉它。
  双击启动时工作目录是 `/`，`.ana/` 落到系统的应用数据目录；想让报告落在项目里，
  用 `npm run start:app`。
