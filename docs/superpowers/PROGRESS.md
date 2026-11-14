# anatomy — 状态与验收

**状态：完成并已合并**（计划 15/15；分支 `main`，已推送到 qweijiaq/anatomy）

## 一条命令验收

```bash
npm install     # 首次
npm run verify
```

末行必须打印：

```
VERIFY: PASS (github, run <runId>)
```

它依次执行并断言下列内容，任何一步不符即 `VERIFY: FAIL — <原因>` 并退出非零：

| 步骤 | 断言 |
|---|---|
| `tests` | 39 个测试文件、811 个测试全过 |
| `typecheck` | 三套 tsconfig（`tsconfig.json` + `tsconfig.test.json` + `tsconfig.desktop.json`）均无诊断 |
| `build` | 编译成功，且 `python_index.py` 被复制进 `dist/` |
| `stub model` | 起一个本地 OpenAI 兼容假模型，回显切片里的真实源码行 |
| `scan` | 取回 GitHub 归档（失败时退回 fixture 并在输出里标明），输出 `path:line` 候选 |
| `analyze` | 写出 `report.md` 等产物；报告含标题、`已取证点占比`、`没看的部分`、`` `path:start-end` `` 证据行 |
| `report` | 删掉已分析树之后仍能重渲染出报告 |
| `inspect` | 打印 `path:start-end` 与原文片段；id 或报告里写的那种引用都行 |
| `app` | 用仓库内的假 REA 跑 `inspect-app` → `app-report` → `app-diff`：定位 REA、读数它的进度、写证据文件、渲染两份报告、比对两次构建 |
| `mcp` | 用 stdio JSON-RPC 起 server，依次问 `anatomy_scan` / `anatomy_report` / `anatomy_evidence` / `anatomy_forget` |
| `packed package` | `npm pack` 出来装进空目录：3 个依赖，`ana scan` 能跑 |
| `sample` | 抽样脚本对真实仓库给出可核对的候选点 |
| `runs` | 刚写下的那一轮必须出现在 `ana runs` 与 `runs --json` 里 |
| `forget` | 拒绝路径、删掉刚生成的那一轮、删第二次报错而不是静默成功 |

模型由仓库内的 `scripts/verify-stub.mjs` 提供（本地 OpenAI 兼容实现，回显切片中的真实源码行），因此**不需要任何 provider key**，结果确定可复现。脚本坚持让产品自己的校验器对着磁盘字节核对引用。网络不可用时自动退回 `tests/fixtures/scan-repo` 并在输出里标明 `(fixture)`，不会静默通过。

用真模型跑同样的流程：

```bash
export ANA_MODEL=...  ANA_API_KEY=...
node dist/cli.js analyze https://github.com/<owner>/<repo> --top 8
```

## 计划与设计

- 设计（已批准，含 11 条裁定）：`docs/superpowers/specs/2026-11-12-anatomy-design.md`
- 实现计划（15 个任务）：`docs/superpowers/plans/2026-11-12-anatomy-mvp.md`
- 执行账本（逐任务审查发现、修复轮次、裁定、遗留项）：`docs/superpowers/sdd/ledger.md`
- 每个任务的 brief 与实现报告：`docs/superpowers/sdd/task-*-{brief,report}.md`

## 15 个任务

| # | 内容 | 提交范围 |
|---|---|---|
| 1 | 骨架与共享类型 | `cb98f4d` `0a141d7` |
| 2 | canonicalize 与行寻址切片 | `2189272` `5218932` |
| 3 | 分析口径（文件选择） | `bc3b654` `02f2335` |
| 4 | 取仓库 / 安全解压 / run 目录 | `00619d2` `00448f6` |
| 5 | profile | `13bdb5b` `ceddfca` |
| 6 | TS/JS 结构图与符号 | `61f7733` `e1ed7ed` |
| 7 | Python ast sidecar | `4ec226f` `909e726` |
| 8 | 信号打分 | `38e760a` `11909b5` `74e4174` |
| 9 | `ana scan`（第一个可用切面） | `e052685` `0deeda8` |
| 10 | 证据校验器与预算 | `c11074f` `9d4a8a5` `56200dc` |
| 11 | judge（模型客户端 + 提示） | `a91a527` `bbc18ce` |
| 12 | rank 与仓库级综述 | `b00bc3c` `d97a428` |
| 13 | 渲染（两层报告 + JSON） | `44fd326` `5074d02` |
| 14 | CLI 接线 analyze/report/inspect | `d6e8db3` `e32e912` `6c87bc0` `fc83bc5` |
| 15 | 评测骨架（gold 集 + 匹配） | `8a40f4d` `91b6447` |

每个任务都走完 实现 → 独立 `code-reviewer` → 修复 → scoped re-review 的闭环；审查发现与裁定见账本。

## 真实运行暴露、单测覆盖不到的缺陷（均已修复）

1. GitHub 归档外层目录被当成分析根，所有路径多一层 → `materialize` 解包单一顶层目录
2. 报告标题取到临时目录名 `tree` → `ReportInput.source`，标题取来源末段
3. `clampBudget` 用 tokenx 的占位窗口（未知模型 4097、`gpt-4o` 8192）当上限，把 10 万预算砍成 4 千 → 不再信任该表
4. `judge` 丢弃自己展示过的切片范围，模型可引用没给过的行号 → 按已展示区间过滤
5. synthesis 失败会丢弃已判完的整轮 → 先落盘判读结果再合成

## 这一版之后补上的东西

验收表之外，后续提交还带来了：

- **桌面窗口**（`electron/` + `renderer/`）：选目录、后台分析、报告（复制 / 在文件夹中显示）、
  历史切换、两份 survey 对比、删除、模型与深度设置，以及不花 token 的预扫
- **`ana inspect-app` / `app-report` / `app-diff`**：没有源码的应用经 REA 出事实报告与两份差异
- **`ana forget`**：删一轮分析，CLI 和窗口都能删；MCP 上对应 `anatomy_forget`
- **打包**：`package.json` 的 `files` 列表让 tarball 只含 `dist/` 与文档（有测试问
  `npm pack --dry-run`，而不是相信那个字段）
- **`npm run audit`**：一条命令给出仓库当前状况的八行结论
- **`docs/superpowers/real-model-eval.md`**：真模型（deepseek-chat）在五个 gold 仓库上的实测——
  已取证点占比 100%，进正文 1–4 个点，引用 3–13 条。此前所有数字都来自 stub
- **`docs/DONE.md`**：十二条可判真假的完成条件，各自附一条命令和一个文件，外加四条明确不做的事
- **`ana runs [--json]`**：窗口一直能列存档，CLI 不能——`report` 和 `forget` 都要 id，
  而知道 id 的唯一办法是 `ls`。现在 CLI 能列出日期、来源、点数、有没有报告
- **`ana forget --keep <n>`**：存档目录原本没有上限——这个工作副本攒到过 282 轮、
  1454 个文件，而 `forget` 只能按 id 一轮一轮删。现在可以只留最新 n 轮

## 明确未做

`ana mcp` 实现四个工具：`anatomy_scan` / `anatomy_report` / `anatomy_evidence` /
`anatomy_forget`，stdio JSON-RPC，无依赖、不调模型。`ana publish` 仍未做，README 里写了裁定理由。
