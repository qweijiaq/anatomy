# SDD ledger — plan: /Users/weijia/Desktop/anatomy/docs/superpowers/plans/2026-11-12-anatomy-mvp.md

Branch: mvp (base 36f5cac, docs only)
Spec: /Users/weijia/Desktop/anatomy/docs/superpowers/specs/2026-11-12-anatomy-design.md (read, present)

## Pre-flight scan

Interface/file-sharing pairs (producer → consumer):

| Pair | Shares | Producer says | Consumer expects | Finding |
|---|---|---|---|---|
| T1 → T2–T15 | `src/contracts/types.ts` | all types + `ReportInput`? | T13 uses `ReportInput` | **ReportInput 未在 T1 定义** → R-1 |
| T1 → T6 | `StructureIndex.notes` | T6 "本任务新增到 types" | T1 声明与否不明 | **归属冲突** → R-2 |
| T2 → T10 | `canonicalizeFile`, `lineRangeOfSnippet` | 唯一规范化入口 | T10 校验依赖它 | 一致 |
| T2 → T11 | `readSlice` | 头尾截断 + `truncated` | T11 喂 prompt | 一致 |
| T3 → T5/T6/T7/T8 | `Scope`, `detectLanguage` | 口径与语言判定 | 四处消费 | 一致 |
| T4 → T9/T14 | `resolveSource`, `openRun`, `closeRun` | run 目录 + 安全解压 | 两处串流水线 | 一致 |
| T9 → T14 | 流水线装配 | T9 只 `runScan` 打印 | T14 再串一遍 | **装配重复** → R-3 |
| T10 → T14 | `validatePoints`, `fitCandidates` | 三态 + 裁剪 | T14 编排 | 一致 |
| T11 → T12/T14 | `judgeCandidates` | 产出 `Judgement` | T12 只吃 `LearningPoint`；T14 吃点 | 一致 |
| T13 → T14 | `renderMarkdown` | 需 `scope` 与 `skipped` | T14 提供 | 一致（待 R-1） |
| T15 → T14 | `runAnalyze` | 空仓库分支 | T14 产出 `runAnalyze` | **T15 的 Files 说 "Create: analyze.ts 的降级分支"** → R-4 |

Per-task self-consistency:

| Task | Tests vs code | Files vs later touches | Finding |
|---|---|---|---|
| T1 | `ana --version` 需从 package.json 读版本；`import.meta.main` | 只建文件 | **`import.meta.main` 在 Node 22.14 不存在** → R-5 |
| T2 | 7 断言覆盖 CRLF/BOM/latin1/越界/截断 | 自洽 | 一致 |
| T3 | 6 断言含三个上限维度与 subpath | 自洽 | 一致 |
| T4 | 三个恶意 tar 全覆盖，`readdir(dest)` 为空 | 自洽 | 一致 |
| T5 | 空仓库分支 | 自洽 | 一致 |
| T6 | `resolved` 纠正相对/裸包名 | 要改 types（R-2） | 见 R-2 |
| T7 | 一次进程 + 缺 python3 降级 | 自洽 | 一致 |
| T8 | 6 条规则断言含合并且有序 | 自洽 | 一致 |
| T9 | 断言 run 产物与 stdout 格式 | 与 T14 重叠（R-3） | 见 R-3 |
| T10 | 编造行号/CRLF/降级/预算 | 自洽 | 一致 |
| T11 | 非法 JSON/重试/缺 key/prompt 含行号 | 自洽 | 一致 |
| T12 | 合并同主题/无证据排后/synthesis 只吃标题 | 自洽 | 一致 |
| T13 | 无点也出报告/片段不翻译 | 自洽 | 见 R-1 |
| T14 | report 不重跑（删 tree 仍出）/inspect/未知 runId | 依赖 T9 的装配 | 见 R-3 |
| T15 | 位置重叠命中/相邻不算/空仓库 | 改 analyze.ts（R-4） | 见 R-4 |

## Rulings

- **R-1 `ReportInput` 归 T1。** T13 消费一个从未被定义的类型，属计划缺陷。裁定：`ReportInput` 在 `src/contracts/types.ts`（Task 1）定义，字段为 `{ problem; topFive; points; validation; profile; scope; skipped }`。代价若错：T13 与 T14 之间要返工一次类型。
- **R-2 `StructureIndex.notes` 归 T1。** 计划 T6 写"本任务新增到 types"，与 T1 一次性定义全部类型冲突。裁定：T1 直接声明 `notes: string[]`，T6 不改 types。代价若错：T6 多一个无关小 diff。
- **R-3 流水线装配只写一份。** T9 与 T14 都串同一条链路。裁定：T9 把内核步骤抽成 `scanRepo(input, opts): Promise<{ run; scope; profile; structure; candidates }>`（`src/kernel/pipeline.ts`），`runScan` 只负责打印；T14 复用 `scanRepo`。代价若错：装配逻辑出现两份，后续改一处漏一处。
- **R-4 T15 只改不建。** 计划 Files 写成 "Create: analyze.ts 的降级分支"。裁定：T15 的改动是 `Modify: src/commands/analyze.ts`（空仓库分支）+ 新建 eval 与测试。代价若错：无。
- **R-5 不用 `import.meta.main`。** Node 22.14 无此属性（22.18+ 才有）。裁定：`src/cli.ts` 末尾用 `if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)` 判定直接执行。代价若错：CLI 在真机上不启动，测试却全绿。
- **R-6 子代理模型不可指定。** 本 harness 的 `task` 工具无 model 参数，无法按 Model Selection 分档。裁定：一律用会话默认模型派发，审查同样。代价若错：贵一些，不影响正确性。

- **R-7 实现由控制器自己做。** 两次派 `general-purpose` 实现子代理（13 次 / 10 次工具调用、158k / 230k tokens、单次 22 分钟）都在写完配置文件后停止，返回一句空壳，没有提交、没有报告。判定：本 harness 的长任务子代理不可用。裁定：实现由控制器亲自完成；每个里程碑后仍派一次 `code-reviewer` 做独立审查；若该子代理同样无法完成，则以机器门（`vitest` + `tsc --noEmit`）+ 自审为准并在此记录。代价若错：失去逐任务独立审查这道保险，正确性更多依赖测试覆盖。
- **R-8 项目本地 npm 缓存。** `npm install` 因 `~/.npm/_cacache` 权限损坏而 EACCES。裁定：一律用 `--cache ./.npm-cache`，并把该目录加进 `.gitignore`。代价若错：无。

## Progress

- Task 1: 进行中。控制器已写 `src/contracts/types.ts`、`tests/cli.test.ts`、`src/cli.ts`；`npm install` 经历两次网络中断与一次缓存权限错误，改用本地缓存重装。

- Task 1: complete (commits 0d6675c..0a141d7, review clean after 1 fix round). 审查发现 1 Critical（缺 shebang）+ 4 Important（symlink 入口判定、缺 rejection handler、版本断言空转、tests 未被 typecheck），全部修复并经 scoped re-review 确认 ADDRESSED。
- Task 1: minor (deferred): `ReportInput` 无仓库标识，Task 13 渲染 `# <repo>` 头部时需扩字段（加 `source: string`）。
- Task 1: minor (deferred): `Profile.languages` 与 `Scope.byLanguage` 语义重叠，需明确谁权威。
- Task 1: minor (deferred): `-v` / `-h` 未写进 USAGE；flag 处理在 switch 之上。
- Task 1: minor (deferred): `npm test` 因 built-artifact 冒烟测试会在 `beforeAll` 跑一次 tsc。
- Task 1: minor (deferred): rejection handler 仅有源码文本断言兜底，缺行为测试。
- Task 1: minor (deferred): `package.json` 缺 `files` 允许列表与 `private`，误发版会打出不含 dist 的包。
- Task 2: complete (commits 0a141d7..5218932, review clean after 1 fix round). 审查 1 Critical（截断 Slice 行号自相矛盾）+ 3 Important（末行空白丢行数、缺孤立 \r 用例、截断断言过弱）+ BOM/latin-1 首行污染，全部修复并经 scoped re-review 确认 ADDRESSED。
- Task 2: minor (deferred): `readSlice` 每次调用重读重规范化整文件，Task 11 会重复，届时加 `Map<string, CanonicalFile>` 缓存。
- Task 2: minor (deferred): `canonicalizeText` 不含 mojibake-BOM 剥离，"唯一路径"仍有缺口。
- Task 2: minor (deferred): `maxLines: Infinity` 语义从"不限"变成"用默认 200"。
- Task 2: Warning (deferred): 末行仅空白且无换行的文件，`readSlice` 可能给出 `startLine..endLine` 只有一行文本（`omitted: null`）。观测不到实际影响的场景，但 Task 10/11 若依赖"text 行数 == endLine-startLine+1"会踩。
- **Ruling（带入 Task 10）：证据校验不得靠 `offsetOfLine` 抛 `RangeError` 来拒绝 `line === lineCount + 1`。** 校验器必须显式断言 `1 <= startLine <= endLine <= lineCount`，再比对片段。理由：`offsetOfLine` 对以 `\n` 结尾的文本多出一个可寻址行首，用它做越界判断会在绝大多数源文件上放行"引用末尾不存在的空行"。
- Task 3: complete (commits 5218932..02f2335, review clean after 1 fix round). 审查 1 Critical（`.gitignore` 前导斜杠未锚定，会把 `src/lib/` 当根级 `/lib` 丢掉）+ 2 Important（root 未校验导致打错路径静默返回空作用域、limit 测试全部在第一个文件就超限因此无法区分 fail-fast）+ 3 Minor，全部修复并经 scoped re-review 确认 ADDRESSED。
- Task 3: minor (deferred): `countLines` 非预算感知，190MB 文本文件会整读一遍。
- Task 3: minor (deferred): `.git` 计入 `vendored`，报告头会显示不存在的 vendored 代码。
- Task 3: minor (deferred): 根目录 `stat` 失败一律报"不存在"，EACCES 被压平且丢弃 cause。
- Task 3: minor (deferred): 新增的 scope 错误是裸 `Error`，CLI 接线时要靠字符串匹配。
- Task 3: minor (deferred): 两个新 limit 测试耦合 `Scope.files` 的 walk 顺序，将来加排序会误伤。
- Task 3: minor (deferred): `src/kernel/scope.ts:464-470` 单文件 stat 失败仍 `continue`，kept+excluded 恒等式对不可读文件不成立。

## 恢复指引

- 已完成 Task 1-3（HEAD `02f2335`）。下一个任务：Task 4（取仓库 / 安全解压 / run 目录）。
- 每个任务的流程：`task-brief PLAN N` → 派 general-purpose 实现 → `review-package PLAN BASE HEAD`（fixture 大时用 `git diff` 自建 src-only 包）→ 派 code-reviewer → 有 Critical/Important 就走修复轮 → scoped re-review。
- 实现子代理在超长开放式提示下会空转（见 R-7）；把要求压成编号清单 + 明确"不要安装依赖/不要重构/只改这几项"后成功率明显提高。
- 每任务成本约 1.2-1.9M tokens（实现 + 审查 + 修复），耗时 3-8 分钟。
- Task 4: complete (commits 02f2335..00448f6, review clean after 1 fix round). 首轮 0 Critical + 7 Important（本地 sha 只哈希树形不含内容、解压无上限可被 gzip 炸弹、`tar -cf .` 的根条目被误判为 unsafe、本地 ref 带日期导致 runId 每天变、`deriveRunId` 接受空 sha、目标目录未验证为空、截断归档被当作空归档）+ 5 Minor，12 项全部修复并各有"回退即失败"的测试。实现子代理中途被截断，收尾两处由控制器补（closeRun 守卫、测试参数笔误）。
- Task 4: warning (carried to Task 5): `hashTree` 遍历包含 `.git`，普通 git 操作就会改变 sha 与 runId，等于抵消"可复现"这条性质。裁定：Task 5 顺手在哈希前排除 `.git`（及 build 产物），并加测试。
- Task 4: minor (deferred): `./` 空名跳过发生在 typeflag 判定之前，该名下的危险类型会 fail-open（无写入）。
- Task 4: minor (deferred): 峰值内存约 3× 上限（raw + inflated + 计划副本）。
- Task 4: minor (deferred): 任何 `RangeError` 都会被改写成"超出体积限制"。
- Task 4: minor (deferred): 下载与解压的字节上限分两个参数传递，调用方只收紧一个会漏。
- Task 5: complete (commits 00448f6..ceddfca, review clean after 1 fix round). 首轮 SPEC FAIL：4 Important（pyproject scripts 解析后被丢弃、带尾注释的 TOML 表头解析报错、未分析语言提示靠白名单因此 `.vue` 占 50% 却静默、三份互相矛盾且漏了 `target`/`.venv` 的排除列表）+ 6 Minor，9 项全部修复并各有"回退即失败"的测试。实现子代理再次在收尾时停止（42 次调用），其残留工作树本身已全绿，控制器直接提交。
- Task 5: warning (carried to Task 6): `NON_CODE_EXTENSIONS` 白名单欠覆盖，`go.sum`/`.env`/`*.rst`/`*.cfg`/`*.pyi` 会被算成 `unanalysed language: other`，制造假警报。裁定：Task 6 顺手补全名单，并把 `other` 提示改成带样例扩展名（`other (vue)`）。
- Task 5: minor (deferred): 未解析条目告警一律说 "outside the analysed scope"，绝对路径/`..`/不存在三种原因未区分。
- Task 5: minor (deferred): 未解析告警未去重，同一目标可能重复出现。
- Task 5: minor (deferred): 内联注释会让 `widget = "w.cli:main"  # cli` 的值带引号与注释。
- Task 5: minor (deferred): `hashTree` 仍不读 `.gitignore`，被忽略的本地缓存目录仍会改变 runId。

## 恢复指引（更新）

- 已完成 Task 1-5，HEAD `ceddfca`。下一个任务：Task 6（structure — TypeScript/JavaScript）。
- 派发实现子代理时把条目压到 ≤5 条，并明确"先提交再自查"：本会话 5 个实现子代理里有 3 个在收尾阶段停止，残留工作树多数已经全绿——**先看 `git status` 与 `npm test`，能提交就直接提交，不要重派**，重派代价是 150-250 万 token。
- 审查用 `code-reviewer`，稳定可靠；fixture 大时自建 src-only diff 包（`git diff -U10 BASE..HEAD -- src tests/*.test.ts`）。
- Task 6 起带着上面的 carry-over warning 一起做。
- Task 6: complete (commits ceddfca..e1ed7ed, review clean after 1 fix round). 2 Important（profile 黑名单漏掉 dotfile 配置与 `.snap` 快照、ts 把 `.css`/`.json`/`.d.ts` 解析成不存在的模块节点）+ 3 Minor，修复经 re-review 确认。
- Task 6: minor (deferred): ipynb 曾被误拉进黑名单导致笔记本静默，已在 Task 7 撤回并留注释。
- Task 7: complete (commits e1ed7ed..909e726, review clean after 1 fix round). 1 Critical（`PYTHONPATH` 可让被分析仓库的 `ast.py` 被执行——直接违反"不执行目标代码"）+ 3 Important（非 UTF-8 locale 下 NDJSON 全部错配并伪报超时、`from . import x` 解析成包自身、构建产物缺 `python_index.py`）+ 2 Minor，6 项全部修复并经 re-review 确认 ADDRESSED。
- Task 7: minor (deferred): `python3` 仍按名字从继承的 PATH 解析，PATH 上有仓库时可换掉解释器。
- Task 7: minor (deferred): `from . import a` 与 `from . import b` 两条边因按 specifier 去重合并成一条。
- Task 7: minor (deferred): 无法解析的 alias 仍会 fallback 到包 `__init__.py`，自边在不可解析时保留。
- Task 8: complete (commits 909e726..74e4174, review clean after 2 fix rounds). 首轮 1 Critical（生成文件照样被打分，codegen 产物占满 topK）+ 4 Important（纯类型声明算作"自研轮子"、整文件塌缩成一个候选、关键字表漏掉 RingBuffer/Backoff/RateLimiter 等本项目最该抓的东西、vendored 陷阱没被真正钉住）+ 6 Minor。第二轮又抓出两个回归（无分号风格的嵌套深度漏计、生成标记过宽误杀真实文件），第三轮确认全部 ADDRESSED。
- Task 8: warning (carried): `it.each(...)(...)` 链式写法不再计入断言密度，vitest 惯用法会漏候选。
- Task 8: minor (deferred): `#!/usr/bin/env node` 使第 2 行起的 banner 不再被识别。
- Task 8: minor (deferred): 400 字符 header 上限会关掉无分号嵌套支持。
- Task 8: minor (deferred): `it.each` 之外的 O(n·m) 扫描。
- Task 9: complete (commits 74e4174..0deeda8, review clean after 1 fix round). `ana scan <repo>` 已可用。3 Important（`scope` 未落盘导致"删掉 tree 也能出报告"做不到、管道提前销毁树且不返回 root 让校验器无从取证、失败重跑后目录仍显示 complete）+ 5 Minor，全部修复确认。
- Task 9: warning (carried to Task 10): 重跑在 `candidates` 阶段失败时，scope/profile/structure 已被覆写但 manifest 又被恢复成 complete，等于"complete 标记盖着混合产物"。
- Task 9: warning (carried): `settleFailure` 自己写 manifest 失败时会再次掩盖真实错误。
- Task 9: minor (deferred): 旧 manifest 无 `status` 字段，失败重跑会把它降级成 failed。
- Task 9: minor (deferred): `ScanOptions` 未转发 `keepTree`。
- Task 9: minor (deferred): `cli.ts` 只剥一层 `anatomy: ` 前缀，用户会看到嵌套前缀。
- Task 10: complete (commits 0deeda8..56200dc, review clean after 2 fix rounds, 348 tests green). 首轮 8 Important——证据只要一个字符就能过检、重复代码被误判成编造、证据不去重会让 avgEvidence 虚高、以 `\n` 开头的片段行号偏移、symlink 可把根外字节拉进来当证据、证据可引用任意大小文件、字段残缺的点能溜到渲染层再崩、token 估算不是上界（tokenx 把空白算 0）——外加默认预算 50 万超过任何真实上下文。两轮修复后经 re-review 全部 ADDRESSED。
- Task 10: warning (carried to Task 11): 重复片段扫描在大文件近 EOF 处退化为二次方（`lineOfIndex` 每次从 0 重算）。
- Task 10: warning (carried): `clampBudget` 按整个上下文窗口夹取，没给回答留空间。
- Task 10: warning (carried): `validatePoints` 未校验 `scope.root` 与 `root` 一致，传错会静默全丢。
- Task 10: warning (carried to Task 11): `canonicalize.ts` 的 `lineRangeOfSnippet` 仍带已修掉的行首偏移 bug 且已无生产调用者——Task 11 若引用它就是踩雷，先删或先修。
- Task 10: minor (deferred): 1 MiB 上限只约束成本不约束相关性；省略 scope 时锁文件仍可被引用。
- Task 11: complete (commits 56200dc..bbc18ce, review clean after 1 fix round, 387 tests). 1 Critical——judge 丢弃了自己展示过的切片，于是"证据存在"被当成"模型看过"，模型可以引用从未出现在 prompt 里的行号并通过校验（"只许引用给定行"沦为君子协定）；+3 Important（每次切片都整文件重新解码、依赖文件经符号链接可把根外字节上传给模型、HTTP 请求无超时）。8 项修复后经 re-review 确认。
- Task 11: warning (carried to Task 12): 响应体读取阶段的 abort 被包装成 `ModelReplyError`，绕过重试判定。
- Task 11: warning (carried to Task 12): `isShown` 未校验 `startLine <= endLine`，倒序范围能过闸（后续由 evidence 层兜住）。
- Task 11: minor (deferred): judge 与 validator 各解码一次，缓存未共享。
- Task 11: minor (deferred): 截断分支当前不可达（窗口恒 ≤200 行），属未测代码。
- Task 12: complete (commits bbc18ce..d97a428, review clean after 1 fix round, 422 tests). 2 Important（synthesis 把模型自己的回复文本当作重试理由塞回 prompt、rank 的 kind 兜底会借用无关文件的分数让弱证据压过强证据）+ 6 Minor，修复确认。
- Task 12: minor (deferred): `rank.ts:61` 的 `isObject` 接受数组，嵌套数组可能被当成 LearningPoint 返回。
- Task 12: minor (deferred): synthesis 的固定失败原因对"空回复"变体也报"不是 JSON"，且不再保留任何诊断文本。
- Task 13: complete (44fd326..5074d02). 2 Important（无法解析的点被静默丢弃却声明"没有遗漏"、TOP 5 会点名正文没有的条目）+ 3 Minor，修复确认。
- Task 14: complete (5074d02..6c87bc0)。两段派发；14B 停在接线前，控制器补 `ANALYZE_USAGE`/`parseAnalyzeArgs` 与三条命令的分发。随后**用真实仓库跑通**暴露两个单测覆盖不到的缺陷：归档外层目录被当成分析根、报告标题取到目录名 `tree`。都已修复（`materialize` 解包单一顶层目录并记 `manifest.treeRoot`；`ReportInput.source` + 口径里的"来源"行）。
- Task 15: complete (8a40f4d..91b6447)。`matchGold`/`readGold`、3 个 gold 集、`eval/run.ts`、空仓库 e2e。
- 真实运行又暴露第三个缺陷：`clampBudget` 用 tokenx 的窗口表（未知模型 4097、gpt-4o 8192）当上限，把 10 万预算压到 4 千并砍掉几乎所有候选；已改为不信任该表（6ea299a）。
- Final review（6 条不变量全部成立）：1 Critical（synthesis 失败会丢掉已经判完的整轮，`ana report` 报 no such run）+ 4 项，全部修复（430129a、55ca377）。
- 终态：532 tests / 23 files 全绿，`npm run typecheck` 两套配置干净，`npm run build` 通过。真机端到端：`scan`（零模型调用）、`analyze`、`report`（删树后重渲染）、`inspect`（`index.js:1-1` + 原文片段）四条命令均在 `sindresorhus/quick-lru` 上验证，报告为中文、标题 `# quick-lru`、已取证占比 100%。
- 未做（明确出界）：MCP server、`ana publish`、合并到 main。分支 `mvp` 保持未合并，等人工决定。
