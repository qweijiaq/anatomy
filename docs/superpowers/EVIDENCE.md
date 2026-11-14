# 证据对照：每条验收要求由哪些测试与文件证明

这个文件不解释产品，只做一件事：把"说完成了"和"能被核对"之间的缺口关掉。每条要求后面是
**能跑出证据的测试名**或**已提交的文件**，两者都可以独立检查。

运行全部测试：`npm test`（32 个文件 / 749 个测试）。最近的完整机器输出提交在
`docs/superpowers/verify-output.txt`。

## 要求 1 — 每个任务走完 实现 → 审查 → 修复 闭环

不是测试能证明的东西，靠记录：

- `docs/superpowers/sdd/ledger.md` — 逐任务的审查发现、修复轮次、裁定、遗留项
- `docs/superpowers/plans/2026-11-12-anatomy-mvp.md` — 15 个任务到提交的对照表，每行附"审查抓到并修掉了什么"
- `.superpowers/sdd/2026-11-12-anatomy-mvp/progress.md` — 同内容的一屏摘要（受版本控制）

## 要求 2 — `npm test` 全绿

`docs/superpowers/verify-output.txt`：`Tests  759 passed`（该文件是带日期的运行快照，见其首行）。

## 要求 3 — `npm run typecheck` 全绿

`package.json` 的 `typecheck` 脚本跑三套配置：`tsc --noEmit`（src）、
`tsc -p tsconfig.test.json`（src + tests + eval）、`tsc -p tsconfig.desktop.json`
（electron + renderer）。任何测试或渲染层文件里的类型错误都会让它失败。

这一条本身曾是个更糟的缺陷：`verify.sh` 把它接在 `| tail -2` 之后，而管道的退出码是 `tail` 的，
所以 tsc 报错时闸门依然打印 `VERIFY: PASS`。现在脚本用 `set -o pipefail` 并显式捕获退出码，
两个配置各造一次真类型错误都验证过会 FAIL。

## 要求 4 — `ana analyze` 对真实开源仓库产出带行号证据的中文报告

三层证据，任一层都能独立核对：

1. **已提交的真实运行转录**：`docs/superpowers/verify-output.txt` — 对
   `https://github.com/sindresorhus/quick-lru` 跑完 scan → analyze → report（删树后重渲染）→ inspect。
2. **代码层面的测试**（`tests/analyze.test.ts`）：
   - `keeps points that cite the real fixture lines, and shows the citation` — 断言
     `lines[evidence.startLine - 1]` 与 `evidence.snippet` 逐字相同，即报告里的行号确实指向那段代码
   - `writes a report that names the repository and its trust numbers` — 断言报告含
     `已取证点占比：\d+\.\d%`、`每点平均证据数`、`## 没看的部分`
   - `produces a report with lang en, switching only the prompts` — 语言开关只换提示模板
3. **渲染层面的测试**（`tests/render.test.ts`，40 个测试）— 标题、口径块、`来源：`、两层结构、
   片段逐字不译、以及"没有点也必须是一份完整报告"。

## 两条核心不变量，各自的证明

**不编造。** 模型写的一切都当作待验证的主张：

- `tests/evidence.test.ts` 逐个拒绝：`drops a fabricated line number instead of throwing`、
  `drops a snippet that exists but on a different line than reported`、
  `drops snippets too thin to certify a point`（一个字符不算证据）、
  `drops a snippet that is not in the file at all`、
  `refuses the trailing empty line a file does not have`、
  `drops a path that escapes the root without reading it`、`drops an absolute path`
- `tests/writing-judge.test.ts` — 引用模型从未见过的行号会被剔除，即使那行在磁盘上真实存在

**不执行被分析仓库的代码。** 全程不 `git clone`、不装依赖、不跑脚本：

- `tests/structure-python.test.ts` — `never imports a stdlib module shadowed from the environment`
  （被分析仓库里放一个 `ast.py` 不会被导入，sidecar 以 `-I` 启动并清洗环境）
- `tests/acquire.test.ts` — 恶意归档（绝对路径、`..`、符号链接、设备、FIFO）全部拒绝且目标目录保持为空
- `tests/scope.test.ts` — 上限与口径的测试；无一处执行目标代码

## 一个不依赖子代理的复核方式

```bash
cd （本仓库根目录）
npm install
npm run verify        # 末行：VERIFY: PASS (github, run <id>)
```

`scripts/verify.sh` 在临时目录里跑完整的 scan → analyze → report → inspect，并用 grep 断言报告
含标题、可信度数、`## 没看的部分`、以及 `` `path:start-end` `` 形式的证据行。模型由仓库内的
`scripts/verify-stub.mjs` 提供，因此不需要任何 provider key，结果确定可复现；引用仍由产品自己的
校验器对着磁盘字节核对。

## Clean checkout

The gate has only ever run in the working copy, where `dist/` and `.ana/` already
exist. A handoff claim needs the other case: clone it, install it, run it.

```
git clone --depth 1 https://github.com/qweijiaq/anatomy.git /tmp/anatomy-clone
cd /tmp/anatomy-clone && npm ci && npm run verify
→ Tests 759 passed | typecheck clean | build ok
→ scan+analyze+report+inspect+forget ok on https://github.com/sindresorhus/quick-lru
→ VERIFY: PASS (github, run c33c78ec2c45, deleted)
```

Nothing but `npm ci` came first: no build, no run directory, no API key. The clone
also showed what the docs had assumed — `ana` is this package's `bin`, and `npm ci`
does not put it on PATH, so the commands printed as `ana ...` only run after
`npm link` or as `node dist/cli.js ...`. Both READMEs now say so.
