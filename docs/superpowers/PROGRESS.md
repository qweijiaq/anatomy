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
| `npm test` | 32 个测试文件、703 个测试全过 |
| `npm run typecheck` | 三套 tsconfig（`tsconfig.json` + `tsconfig.test.json` + `tsconfig.desktop.json`）均无诊断 |
| `npm run build` | 编译成功，且 `python_index.py` 被复制进 `dist/` |
| `ana scan <真实仓库>` | 取回 GitHub 归档，输出 `path:line` 形式的候选 |
| `ana analyze` | 写出 `report.md` 等产物；报告含标题、`已取证点占比`、`没看的部分`、以及 `` `path:start-end` `` 证据行 |
| 删除已分析树后 `ana report` | 仍能重渲染出报告 |
| `ana inspect <evidenceId>` | 打印 `path:start-end` 与原文片段 |

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

## 明确未做

MCP server（6 工具与 `submit_points`）与 `ana publish` 不在本次范围内，README 的「Not built yet」列着它们。
