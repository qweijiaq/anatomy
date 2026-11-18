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
[对比]  [应用 · N]  [设置 · provider · model]
```

- **先扫一眼**：主页面上的次要按钮。零 token、不调模型，只列出「值得先看的 12 处」
  与它们的分数。绝大多数时候人打开一个陌生仓库想先知道哪里有料，而不是先付一次完整
  分析的钱。结果写进 `.ana/scratch` 并覆盖，不像完整分析那样每次留一份记录；换了仓库，
  旧结果不会再显示。
- **报告**：跑完一次分析后直接显示。顶上的**复制**把 Markdown 放进剪贴板（按钮会短暂
  变成「已复制」），**在文件夹中显示**定位到 `.ana/runs/<id>/report.md`。报告不只是窗口
  里的一页，它是磁盘上的一个文件；页面和 `report.md` 逐字相同——同一份渲染器。
- **目录**：报告左侧的 rail 列出每个二级标题，点一下跳到那一节；长报告的滚动不再靠手感。
- **产出**：报告顶部的“导出整套产出”把同一次分析写成 `SUMMARY/DECISIONS/RISKS/ONBOARDING/HOTSPOTS/QUIZ` 和证据文件，默认 **0 次额外模型调用**；勾选“术语表 / FAQ”会多花一次批量调用，失败时其余文件仍然保留。导出后可一键在文件夹中显示。
- **追问**：报告底部的输入框问一个后续问题，答案只能引用这次分析存下来的证据；模型给了列表
  以外的行号，这次回答会被丢弃。每次提问花一次模型请求，界面上写明了。
- **用量**：rail 显示这次分析实际调用了几次模型、输入/输出各多少 token；超过 CLI 设的整轮上限时，
  报告会写明“预算到顶，后面的候选没有再判”。
- **继续**：一次分析在判读阶段中断后，历史里会留下“未完成 · 已判 N 个候选 · 继续”。点它会重新
  取回同一棵树、复用已判的候选，结果写成新的一轮；旧的失败记录不覆盖。
- **引用**：正文里的 `path:start-end` 是一个按钮。点开显示这次分析生成时存下的原文片段，
  以及它属于哪个学习点。片段已经过一次字节核对，但它是**当时的证据**，不是对当前源码的
  实时读取——面板上写明了这一点。
- **历史**：首页底部列出 `.ana/runs` 里所有跑完的 run，每行带学习点数、取证率和相对时间；
  行尾的 `×` 两段确认后删除（`ana forget` 的图形版）。报告多于三份时可以按仓库、标题或
  日期筛选；窗口重新获得焦点时会重读磁盘，CLI 新跑出的报告不用重启就能看到。
- **对比两次分析**：从历史里挑两次源码分析，对照学习点数、取证率、候选数、文件与行数，
  以及后一次新增或消失的标题。它比较的是事实，不逐句比较模型写的正文。
- **应用 · N**：`ana inspect-app` 重建过的应用。页头可切换看哪一份，`删除`同样两段确认。
  内容分三块：Electron 暴露面、contextBridge 暴露的每个成员、IPC 通道按名字分级。
- **对比**：挑两份 survey 算差异，吸顶选择条，改前/后不用滚回顶部。
- **设置**：provider、模型、Key、报告深度和**报告语言**（中文 / English）。窗口底部显示
  版本号；删除已存的 Key 需要二次确认。
- **深色模式**：跟随系统，不需要开关；两套颜色都在同一组 token 里。

窗口**会跑分析**：选目录、填地址，它做的事和 `ana analyze` 完全一样，进度一条条推上来
（取证 → 判读 → 排序 → 综述）。它**不跑**的是应用重建（`ana inspect-app`）——那一段是
几分钟的 REA 计算，没有可汇报的进度，所以留给 CLI，窗口只读它留下的 survey。除了这一块，
界面上的每次点击都是即时的：报告、历史、对比全部读磁盘上已有的结果。

## 还没做

- **引用的另一种读法**：片段来自 `points.json`；窗口不会按当前磁盘重新读一遍源码。要核对
  「现在这一行还是不是它」，用 `ana inspect <path:start-end>`。
- **追问没有多轮上下文**：每次提问独立，不把上一次回答带进下一次；这样答案的范围只由报告决定，
  不会被前一轮的错误越带越远。
- **分析开始后不能取消**。窗口只显示进度；要停下就关掉窗口。这不是疏忽：一次分析
  是一串模型调用，中途取消要把它传进每一层（`AbortSignal`），而它现在的价值不如把
  那件事做对。长任务用的是 CLI，那里的 Ctrl-C 本来就能用。
- 没有打包成 .dmg 分发（`electron-builder` 未接入）。本地要一个能双击的 app 用
  `npm run build:desktop && npm run build:bundle`，产物在 `out/anatomy.app`（约 233MB，
  Electron 运行时加 `dist-electron` / `dist-renderer` 的副本，已在 .gitignore 里）。
  `npm run clean` 可以清掉它。
  双击启动时工作目录是 `/`，窗口的所有读写都会落到系统的应用数据目录；想让报告落在项目里，
  用 `npm run start:app`。
