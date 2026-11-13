# anatomy

把一个仓库拆成一份**带行号证据的设计笔记**：值得学的决定、它们的代价、以及证据在哪一行。验证不过的说法不会出现在报告里。

源代码是公开的，稀缺的不是代码，是判断力——从二十万行里挑出二十个真正值得学的决定。

```bash
npm install
npm run verify        # 末行应为 VERIFY: PASS
```

## 桌面应用

```bash
npm run build:desktop && npm run start:desktop
```

窗口里填一个仓库地址就能跑分析，模型 Key 在应用内配置（加密存在本机，
渲染进程拿不到）。provider 预设与 reading-notes 同一套，含 Anthropic 原生协议。
细节见 [docs/desktop.md](docs/desktop.md)。

## 四条命令

```bash
ana scan <repo>                  # 零模型调用：告诉你哪里最值得看
ana analyze <repo> [--top 8]     # 完整分析，产出报告
ana report <runId>               # 用已存产物重渲染（分析树已删也能出）
ana inspect <evidenceId>         # 打印某条证据的文件与原文片段
```

`<repo>` 可以是 GitHub 地址、任意 tarball 地址，或本地目录。默认分析最新 release tag，`--ref` 覆盖，`--subpath` 限定 monorepo 的某棵子树。

真机运行需要模型凭据：

```bash
export ANA_MODEL=gpt-4o-mini  ANA_API_KEY=sk-...
node dist/cli.js analyze https://github.com/sindresorhus/quick-lru --top 8
```

## 报告长什么样

真实运行（`sindresorhus/quick-lru`）的开头：

```markdown
# quick-lru

## 这次分析在解决什么

一个小型工具库，用语言内建结构替代显式的数据结构。

## 最值得学的 1 件事

1. 用插入顺序维护淘汰顺序，不额外维护链表

## 这次分析的可信度

- 已取证点占比：100.0%
- 被丢弃证据数：0
- 每点平均证据数：1

## 分析口径

- 来源：https://github.com/sindresorhus/quick-lru
- 规模：13 个文件 / 62687 字节 / 2606 行
```

正文里每个点都带 `index.js:1-1` 这样的定位和逐字片段；末尾必有「没看的部分」，列出不支持的语言、被预算裁掉的候选、以及被 withheld 的点。

## 两条不变量

产品的全部价值压在这两条上，代码里也按这两条组织：

1. **不编造。** 模型写的一切都是待验证的主张。`src/kernel/evidence.ts` 拿片段去比对磁盘上的字节，`src/writing/judge.ts` 还会拒绝引用它从未展示给模型的行号——两者都过，才会出现在页面上。
2. **不执行被分析仓库的代码。** 不 `git clone`、不装依赖、不跑脚本；Python 用 `ast` 解析，sidecar 以 `-I` 启动并清洗环境，避免被分析仓库的 `ast.py` 之类顶替标准库。

## 结构

```
src/kernel/     无 LLM 的取证内核：取仓库、口径、结构图、信号、证据校验、预算
src/writing/    唯一花 token 的一层：提示、judge、排序、综述
src/render/     一层数据两种渲染：叙述 + 可折叠配方、以及 JSON
src/commands/   scan / analyze / report / inspect
eval/           gold 集与召回率脚本（npm run eval）
```

## 知道自己会看漏

29 个 gold 仓库、90 个标注点，当前候选召回率 **60%**。

也就是说四成的标注点连候选都没进，模型再强也写不出来。这个数字留在仓库里，比藏起来有用：

```bash
npm run eval:recall
```

## 未做

- MCP server、`ana publish`。
- 其他语言的结构分析：目前只认 TS/JS 与 Python。
- **报告的英文骨架**。`--lang en` 只切换模型写的正文，标题与栏位仍固定中文——
  `src/render/markdown.ts` 里没有英文分支。想要一份全英文报告，现在只做到一半。

设计、计划与执行记录见 `docs/superpowers/PROGRESS.md`。
