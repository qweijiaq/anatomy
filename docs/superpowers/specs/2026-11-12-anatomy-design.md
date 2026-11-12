# anatomy — 设计文档

日期：2026-11-12
状态：待批准（已过 builder 检查，10 项裁定已全部落定，见 §10）
工作名：`anatomy`（CLI `ana`），可随时改名

## 1. 要做什么，为什么

输入一个开源仓库的地址，输出一份**拆解报告**：这个项目在解决什么问题，它做了哪些值得学的设计决定，每个决定面对什么约束、常见做法是什么、它怎么干、为什么有效、代价是什么、证据在哪一行、我要抄的话最小改动是什么。

灵感来自 REA（`morluto/rea`）的方法论，但不是它的技术：REA 解决"没有源码怎么看懂"，本项目解决"有源码怎么判断哪些值得学"。源码是公开的，稀缺的不是代码，是**判断力**——从二十万行里挑出二十个真正值得学的决定。

第一批读者想做两件事之一：搞明白"原来还能这么干"，或者拿它改自己的代码。同一份底层数据，两种渲染。

## 2. 目标

- 一次命令，从 URL 到一份能读完的报告
- 每个结论都可追溯到 `文件:行号`，snippet 必须是原文精确子串
- 明确产出"不知道的部分"，不装作全懂
- 同样的证据能渲染出叙述层和配方层
- 默认花用户自己的模型 key，我们的推理成本为零

## 3. 非目标

- 不做全语言覆盖。第一版只认 TypeScript/JavaScript 和 Python
- 不做"代码问答"——现成的 coding agent 已经比我们做得好
- 不做自动改代码。只给配方，不动用户的仓库
- 不做实时监视、增量索引、PR 评论机器人
- 不做"项目概述/wiki"。那是 DeepWiki 的地盘，我们输

## 4. 反目标（技术成功但产品失败）

- 产出 100 个平庸的点，而不是 5 个让人"哦"一下的点
- 读者读完说不出这个仓库的核心取舍
- 把 README 和目录结构换个说法复述一遍
- 证据指向的行号是错的，或者引用的代码根本不在那儿
- 配方层教人去搬一个搬不动的东西（框架不同、运行时不同、数据量差三个数量级）

## 5. 约束

- **取仓库不能走 `git clone`**：实测在这台机器上连 GitHub 会挂死（十分钟无进展），`codeload.github.com` 的 tarball 秒下。取仓库一律走归档下载或 API，同时接受本地已有路径
- **不执行被分析仓库的任何代码**：不 `npm install`、不跑 `setup`、不跑测试。只读文件系统
- 规模上限按**分析口径**计（见 §10 R2）：≤ 200 MB、≤ 200k 文件、≤ 500k 行，超过拒绝并说清超了哪一项
- **单次分析有 token 预算**（默认 500k tokens）。超预算就减候选数，不静默截断，裁剪写进报告头
- 模型可替换：默认从环境变量取 `ANA_MODEL` + `ANA_API_KEY`，不锁厂商
- 跨语言不引入需要原生编译的依赖。Node 22 / Python 3.9 是已知可用的环境
- 报告会公开，所以要能说清"这份报告看了什么、没看什么"

## 6. 走过的三条路

**一、工具集挂在现成 coding agent 上**（REA 的做法）。用户在自己装的 Claude Code 里调用，我们只做确定性取证，对方模型负责判断和写作。
- 挣：不用写编排；推理不花钱；`npx` 分发
- 赔：用户被限死在"装了 coding agent 的人"；报告样式管不了；拿不到使用数据

**二、托管服务，贴 URL 出报告页**（DeepWiki 的做法）。
- 挣：谁都能用；结果可控；可分享可索引
- 赔：推理成本全自己掏，大仓库一次几美元；候选筛查、取证、写作、校验四条流水线都得自己扛；要防滥用

**三、混合：引擎在本地跑，模型用用户自己的，结果可选上传成公开报告页。**
- 挣：推理零成本，却仍有"点开就能看"的传播面；渲染在内核里，样式说了算
- 赔：要装 Node；上传内容的质量和合规管不住

**选了第三条。** 待验证的只有一件事：挑出来的学习点够不够好。这条路把验证成本压到最低，又没把产品封在小圈子里。第二条的成本，等确认东西值得做之后再付。

## 7. 定下来的做法

### 7.1 分层

```
内核（不含任何 LLM）:  acquire → profile → structure → signals → 候选点
写作层（调模型）:      judge → rank → synthesis → LearningPoint（结构化）
校验层（本地）:        canonicalize · 子串/行号校验 · 丢弃或降级
渲染层:                报告（叙述层 + 配方层）/ JSON / 公开页
外壳:                  CLI  ·  MCP server  ·  （第二步）publish
```

判断和写作是唯一花 token 的一段，被两个确定性层夹住：前面用规则筛出少量候选，后面用本地校验挡住瞎编。

### 7.2 取证引擎（无 LLM）

1. **acquire**：解析 ref（默认最新 release tag，`--ref` 覆盖，无 tag 用默认分支 HEAD 并记录抓取日期）→ tarball 下载 → 解压到私有临时目录 → 记 sha、license、文件数、行数、分析口径。
   - 支持 GitHub 与普通 tarball URL；`--subpath` 限定 monorepo 的分析根
   - 本地非 git 目录：sha 位置放树内容哈希，并标注"非 git 快照"
   - 超限直接拒绝，说清是它太大还是范围没选对
2. **profile**：语言分布、清单文件、入口点、测试/CI/文档、代码年龄线索（用 CHANGELOG 和注释，不用文件时间戳）
3. **structure**：模块图 + 符号索引，**懒解析**——先解析入口与被 import 闭包触及的文件，其余按需
   - TS/JS：`typescript` 包的 `createSourceFile` / `preProcessFile`，拿精确 import/export 与符号；**不引入 tree-sitter**，避免原生编译
   - Python：`python3` 长驻 sidecar 跑标准库 `ast`，批量收路径、出 JSON，零依赖
   - 其他语言：不分析，报告末尾明写"未分析：Rust（42%）"
4. **signals**：纯规则打分，产出候选 `(path, line, kind, score)`
   - 自研轮子：实现了标准库/框架已有的能力（手写 DI、序列化、调度器、状态机、缓存）
   - 抽象浓度：接口/抽象类多于具体实现；目录即边界且被跨目录 import 打破
   - 显式决策痕迹：`because` / `instead of` / `tradeoff` / `we chose` / `workaround` / `why not`
   - 演化痕迹：`legacy` / `rewritten` / `removed` / `deprecated`，CHANGELOG 里的转向
   - 难度热点：单函数长度、分支数、递归、`unsafe`、锁、原子操作、手写缓冲
   - 测试作为规格：复杂 fixture、边界断言密集的目录
   - 取 top K（默认 30）进候选池，K 随预算缩放

### 7.3 LearningPoint（核心数据结构，唯一资产）

```ts
type LearningPoint = {
  id: string
  title: string                 // 一句话：它做了什么决定
  kind: 'architecture' | 'algorithm' | 'data-model' | 'api-design'
      | 'performance' | 'testing' | 'tooling' | 'process'
  problem: { constraint: string; stakes: string }
  alternatives: Array<{ approach: string; cost: string }>   // 常见做法及代价
  theirs: { summary: string; evidence: Evidence[] }
  mechanism: string             // 为什么有效，不看代码也讲得通
  tradeoffs: Array<{ cost: string; whenItHurts: string }>
  confidence: 'high' | 'medium' | 'low'
  unknowns: string[]            // 它没让我们看到的部分
  recipe: null | {              // 只在高置信 + 前置条件可判定时生成
    prereqs: string[]
    minimalForm: string
    avoidWhen: string[]
  }
}
type Evidence = {
  id: string; path: string
  startLine: number; endLine: number
  snippet: string               // 必须是 canonicalize 后的精确子串
}
```

### 7.4 本地校验（不许模型自证）

- **切片器和校验器共用一个 canonicalize**：UTF-8 解码（失败退回 latin-1）、剥 BOM、CRLF→LF、剥行尾空白。模型看到的字节和校验比较的字节是同一份
- `snippet` 必须是该文件 canonicalize 后的精确子串
- `startLine` 是 snippet 第一行所在行号，`endLine` 是最后一行；片段必须整行对齐
- 引用路径必须真实存在且在分析口径内
- 失败分两种（§10 R4）：证据**缺失**→ 点不能是 high，降为 low 并写进 unknowns；证据**错误**（路径/行号/snippet 任一不符）→ 直接丢弃
- 报告头报三个数：已取证点占比、被丢弃证据数、每点平均证据数

### 7.5 写作层的上下文预算

每个候选只喂一次：
- 目标符号的函数体（超长截断到 200 行，头尾各留）
- 该文件的 import/export 区
- 直接依赖的 1–2 个定义（不递归）
- 该目录的 README/注释片段（若有）

三段写作（§10 R5）：`judge`（每候选一个点）→ `rank`（内核分数 × 置信度，合并同主题）→ `synthesis`（只吃 profile + 模块图 + 全部点的标题和一句话，产出"这仓库在解决什么"和"最值得学的 5 件事"）。三段各自记账。

### 7.6 渲染

一份报告，两个明确的层：

- **层一（叙述，人人读）**：每个点 3–6 段：约束 → 常见做法及代价 → 它怎么做（带行号证据） → 为什么有效 → 代价
- **层二（配方，折叠）**：要在自己项目里用 → 前置条件 → 最小代码形态 → 什么情况下别用
- **顶部一页纸**：这仓库整体在解决什么、最值得学的 5 件事、这次分析的可信度（取证率、预算使用、分析口径）
- **末尾**：没看的部分（不支持的语言、被预算裁掉的候选、判断不了的地方）

**语言**：报告默认中文。`--lang en` 换一套 prompt 模板，其余不变；代码片段永远保持原文，不翻译。第一版只交付中文版，让 gold 标签、盲评、召回判断由同一批人完成。

产物：`report.md`（人读）、`report.json`（机读）、`evidence.json`（证据包）

### 7.7 外壳

- CLI：`ana analyze <url|path>`、`ana report`、`ana inspect <evidence-id>`
- MCP server **6 个工具**：取仓库、profile、结构图、信号候选、带行号的切片读取，以及 `submit_points`——跑同一个校验器和渲染器，拒绝时回传原因（§10 R1）。这就是"路线一"作为免费入口，但不是免检入口
- 第二步：`ana publish` 上传成公开报告页

### 7.8 评测（不是可选项）

- 10 个仓库的 gold 集：仓库 + 固定 sha + "应该被发现的 5 个点"（含期望的 `file:line`），作为 fixture 提交
- 匹配规则：证据位置重叠（同 path 且行区间相交 ≥1 行，或同一符号名），不用 LLM judge
- 指标：召回率、已取证点占比、被丢弃证据数、盲评分数
- 盲评：把一个点的叙述层单独给没读过该仓库的人打分（1–5），第一版手工 markdown 流程
- 反目标检查：读完能不能说出这仓库的核心取舍

## 8. 留给 builder 决定的

- 语言优先级，以及将来是否为了 Rust/Go 引入 tree-sitter
- signals 各规则的权重与阈值调参
- 报告排版细节、公开页的技术形态
- 结构索引跨运行复用（run store 本身已定，见 §10 R8）
- 模型选择与 prompt 的具体形态

## 9. 风险

- **最大的风险是平庸**：产出正确但没人想读的东西。盲评就是为这个设的
- 大仓库的 profile 阶段可能比预期贵，靠分析口径、上限和采样顶住
- 公开页的合规：有人会传不该公开的代码。第一版只做"自己看"，publish 等确认安全再开

## 10. builder 检查的裁定

builder 提出 10 个未定处。九项由我裁定，一项需要你定（见对话）。

**R1 校验是契约，不是外壳功能。** MCP 加第 6 个工具 `submit_points`，与 CLI 共用同一校验器和渲染器。否则"每条结论可追溯"这条承诺就取决于你用哪个壳，质量指标也只覆盖一半。"路线一免费"只是免费，不是免检。

**R2 上限按分析口径算。** 口径 = tarball 条目减去 `.gitignore` 命中的、`vendor|third_party|dist|build|*.min.*|lockfile`、二进制、大于 1 MB 的 fixture。口径写进报告头。结构解析整树但懒：只解析入口和 import 闭包触及的文件，signals 也只在口径内打分（否则会把 vendored React 当成"自研轮子"，这是假候选的最大来源）。

**R3 证据规范化只有一个函数。** 切片器和校验器共用 canonicalize，模型看到的字节就是校验比对的字节。CRLF、BOM、latin-1、tab 转换这些坑一次性关掉，不靠约定。

**R4 校验结果三种，别混。** 证据缺失 → 降级为 low + 进 unknowns；证据错误 → 丢弃；证据齐全 → 保留。原稿"通过率必须 100%"是同义反复（丢完就是 100%），换成三个有信息量的数。

**R5 写作层三段。** judge 出点 → rank 去重排序 → synthesis 出仓库级综述。综述必须单独一次调用，因为 judge 只看单个候选，看不到全局；而内核不许用 LLM。

**R6 运行时归属。** Node CLI 为主，`python3` 是长驻 sidecar（一次启动、批量收路径、出 JSON、退出清进程），不是每文件一次。缺 python3 就把 Python 标为未分析，不硬失败也不猜。

**R7 版本解析。** 默认最新 release tag（可复现），`--ref` 覆盖，无 tag 用 HEAD 且记录抓取日期。支持 GitHub 与普通 tarball URL。`--subpath` 进第一版——不然 200k 上限会把大多数 monorepo 直接拒掉。

**R8 产物落在磁盘上。** `.ana/runs/<runId>/` 存 manifest、结构索引、points、report、evidence；被分析的树留在系统临时目录，run 结束删除。`runId` 由 (sha, ref, subpath, 引擎版本) 派生，所以同输入同 id。evidence id 由 runId + path + startLine 派生。MCP 的 repo handle 就指向 runs 目录，TTL 24 小时或显式关闭。

**R9 预算只认 token。** 先用 tokenizer 预估每个候选的上下文，选装得下的 K；运行中记账兜底。金额只是示意，因为 provider 价格不可知。裁掉多少写进报告头。

**R10 评测匹配靠位置。** gold 点与产出点按证据位置重叠匹配（同 path 且行区间相交，或同符号名），不加第二个 LLM judge——省预算、可复现。gold 固定 sha 提交成 fixture。

**R11 报告中文为主。** 默认中文，`--lang en` 留作模板开关。理由不在市场：第一版要由同一批人读 gold 标签、做盲评、判召回，验证链条越短越好。英文版等"点够不够好"确认之后再翻，那时只是换模板。代码片段永远保持原文，不翻译。
