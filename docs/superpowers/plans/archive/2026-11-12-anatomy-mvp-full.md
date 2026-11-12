# anatomy MVP Implementation Plan

> **ARCHIVED — the full task-by-task text this work was executed from.** Kept verbatim, including
> every step and test, with the checkboxes left as they were during execution. Judge completion from
> `docs/superpowers/plans/2026-11-12-anatomy-mvp.md` (the one-page plan of record), not from this file.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一条命令把一个开源仓库拆成一份带行号证据的拆解报告，每个"值得学的点"都能被本地校验器证明没编造。

**Architecture:** 三段夹层——确定性内核（取仓库、口径、结构、候选信号，无 LLM）→ 写作层（调模型产出结构化 LearningPoint）→ 本地校验与渲染。内核先落地即可用（`ana scan`），写作层接上后是完整产品（`ana analyze`）。所有证据在切片和校验之间共用一个 canonicalize 函数。

**Tech Stack:** TypeScript / Node 22.14、vitest、`typescript` 包编译器 API（无原生编译）、Python 3.9 标准库 `ast`（长驻 sidecar）、tokenx（token 预估）、undici 内置 fetch。

**Spec:** `docs/superpowers/specs/2026-11-12-anatomy-design.md`

## Global Constraints

- Node 22.x（≥22.14）、npm；**不引入任何需要原生编译的依赖**（spec §5）
- **不执行被分析仓库的任何代码**：不 npm install、不跑 setup、不跑测试（spec §5）
- 分析口径上限：200 MB / 200k 文件 / 500k 行，超限拒绝并说明维度（spec §5、R2）
- 单次预算默认 500k tokens，**只认 token 不认金额**（R9）
- 模型凭据只从 `ANA_MODEL` / `ANA_API_KEY` 读，不锁厂商（spec §5）
- 报告默认中文，`--lang en` 是模板开关；代码片段永远保持原文，不翻译（R11）
- 每个 `Evidence.snippet` 必须是被分析文件 canonicalize 之后的**精确子串**（R3）
- 输入支持：GitHub URL、任意 tarball URL、本地目录；默认 ref = 最新 release tag，无 tag 用 HEAD 并记抓取日期（R7）
- 证据校验三态不可混：缺失 → 降级 low + 进 unknowns；错误 → 丢弃；齐全 → 保留（R4）

## Review Focus

最可能让人当场不信这个软件的五类输入，按可能性排序。每条在下面标注了由哪个任务用测试钉住：

1. **CRLF / BOM / latin-1 源文件**——证据必须仍然校验通过，行号对得上。人是全怀了这一条才敢信"可追溯"。（Task 2）
2. **畸形或恶意 tar**（绝对路径、`..`、符号链接、设备文件）——必须拒绝，且一个字节都不能写到目标目录之外。（Task 4）
3. **模型返回非法 JSON，或编造 `file:line`**——不许崩，该点必须被丢弃并计入指标，报告头如实显示。（Task 10）
4. **空仓库 / 只有 README / 目标语言零文件**——报告照常产出，明确说明为什么没有点。（Task 15）
5. **缺 python3、`--subpath` 不存在、仓库没有 tag**——优雅降级并把事实写进报告头，不静默跳过。（Task 7、Task 5）

## File Structure

```
package.json  tsconfig.json  vitest.config.ts
src/
  cli.ts                    命令解析与分发
  commands/{analyze,report,inspect,scan}.ts
  contracts/types.ts        全部共享类型，无副作用
  kernel/
    canonicalize.ts         唯一规范化 + 行号偏移 + 切片读取
    scope.ts                分析口径：ignore 规则、语言判定、上限
    acquire.ts              ref 解析、下载、安全解压
    profile.ts              语言分布、清单、入口
    structure/ts.ts         TS/JS 模块图与符号
    structure/python.ts     python3 sidecar 客户端
    structure/python_index.py
    structure/index.ts      合并两个语言的 StructureIndex
    signals.ts              规则打分 → Candidate[]
    evidence.ts             证据校验器
    budget.ts               token 预估与裁剪
  writing/
    client.ts               模型客户端（可注入，测试不联网）
    judge.ts                候选 → LearningPoint
    rank.ts                 去重、排序
    synthesis.ts            仓库级综述
    prompts/zh.ts           中文模板（--lang en 留位）
  render/{markdown.ts,json.ts}
  store/runs.ts             .ana/runs/<runId>/
tests/
  fixtures/                 小型假仓库、畸形 tar、编码样本
```

分文件原则：`kernel/` 里任何文件都不许 import `writing/`；`contracts/types.ts` 谁也不许反向 import。

---

### Task 1: 项目骨架与共享类型

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/contracts/types.ts`
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `src/contracts/types.ts` 导出全部类型——`SignalKind`、`Candidate`、`Evidence`、`LearningPoint`、`CanonicalFile`、`Slice`、`Scope`、`ScopeFile`、`StructureIndex`、`ModuleNode`、`ImportEdge`、`SymbolRef`、`Profile`、`RunManifest`、`ValidationResult`、`Judgement`。后续每个任务都从这里 import，不许就地另造类型

- [ ] **Step 1: 初始化项目与依赖**

`npm init -y`，依赖：`typescript@5`、`vitest`、`tsx`、`tokenx`。`package.json` 加 `"type": "module"`、`"bin": {"ana": "./dist/cli.js"}`、`"version": "0.0.1"`、`"engines": {"node": ">=22.14"}`。脚本：`build`（tsc）、`test`（vitest run）、`typecheck`（tsc --noEmit）。`tsconfig.json`：`strict: true`、`module: nodenext`、`target: es2022`、`outDir: dist`、`rootDir: src`、`verbatimModuleSyntax: true`。`.gitignore`：`node_modules/`、`dist/`、`.ana/runs/*/tree/`

- [ ] **Step 2: 写共享类型**

`src/contracts/types.ts` 只放类型和常量，无运行时代码。字段严格照 spec §7.3，`Evidence` 带 `id`。补充三个 spec 里已裁定但需要落成类型的：

```ts
export type Candidate = { id: string; path: string; line: number; kind: SignalKind; score: number; matched: string[] }
export type CanonicalFile = { path: string; text: string; lineCount: number; encoding: 'utf8' | 'latin1'; hadBom: boolean }
export type Slice = { path: string; startLine: number; endLine: number; text: string; truncated: boolean }
export type ValidationResult = {
  kept: LearningPoint[]
  downgraded: Array<{ pointId: string; reason: string }>
  dropped: Array<{ pointId: string; reason: string }>
  stats: { evidenceRate: number; droppedEvidence: number; avgEvidence: number }
}
export type Judgement = { points: LearningPoint[]; usage: { in: number; out: number } }
```

- [ ] **Step 3: 写失败测试**

`tests/cli.test.ts`：`ana --version` 打印 `package.json` 的 version 且退出码 0；`ana` 无参数打印用法到 stderr 且退出码 2；`ana bogus` 退出码 2 并提示未知命令。

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL，`Cannot find module '../src/cli.js'`

- [ ] **Step 5: 实现 `src/cli.ts`**

导出 `runCli(argv: string[], io?: {out: Writable; err: Writable}): Promise<number>`，顶部只做一个 `switch (command)`，未知命令走默认分支。文件末尾：`if (import.meta.main) process.exit(await runCli(process.argv.slice(2)))`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/cli.test.ts && npx tsc --noEmit`
Expected: PASS，无类型错误

- [ ] **Step 7: 提交**

```bash
git init && git add -A && git commit -m "chore: scaffold anatomy with shared contracts"
```

---

### Task 2: canonicalize 与切片读取

**Files:**
- Create: `src/kernel/canonicalize.ts`
- Test: `tests/canonicalize.test.ts`
- Fixtures: `tests/fixtures/encoding/{crlf.ts,bom.ts,latin1.ts,trailing.ts}`

**Interfaces:**
- Consumes: `CanonicalFile`、`Slice`
- Produces:
  - `canonicalizeFile(absPath: string): Promise<CanonicalFile>`——按 UTF-8 严格解码，失败退回 latin-1；剥 BOM；`\r\n` 与孤立 `\r` 归一为 `\n`；剥每行行尾空白；`lineCount` 以 `\n` 计，末行无换行也算一行
  - `offsetOfLine(text: string, line: number): number`——1-based 行号 → 0-based 字符偏移；越界抛 `RangeError`
  - `lineRangeOfSnippet(fileText: string, snippet: string): { startLine: number; endLine: number } | null`——snippet 不在文中返回 `null`
  - `readSlice(absPath: string, startLine: number, endLine: number, opts?: { maxLines?: number }): Promise<Slice>`——`maxLines` 默认 200，超出保留头尾各半并置 `truncated: true`

- [ ] **Step 1: 写失败测试**

```ts
// CRLF：行号不能因为 \r 而错位
expect((await canonicalizeFile(crlfFixture)).lineCount).toBe(3)
expect((await canonicalizeFile(crlfFixture)).text.includes('\r')).toBe(false)
// BOM：第一行不能带 \uFEFF，否则 snippet 永远比不中
expect((await canonicalizeFile(bomFixture)).text.startsWith('import')).toBe(true)
expect((await canonicalizeFile(bomFixture)).hadBom).toBe(true)
// latin-1：非法 UTF-8 退回 latin-1 而不是抛错
expect((await canonicalizeFile(latin1Fixture)).encoding).toBe('latin1')
// 行尾空白被剥掉后，snippet 仍能定位
expect(lineRangeOfSnippet(canonText, 'const x = 1')).toEqual({ startLine: 3, endLine: 3 })
// 不存在的片段
expect(lineRangeOfSnippet(canonText, 'nope')).toBeNull()
// offsetOfLine 越界
expect(() => offsetOfLine('a\nb', 5)).toThrow(RangeError)
// 超长切片保留头尾
expect((await readSlice(bigFile, 1, 500)).truncated).toBe(true)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/canonicalize.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现四个函数**

`canonicalizeFile` 是唯一做解码和归一的地方。**任何其他模块都不许自己 `readFile` + 正则清洗**——这是 R3 的全部意义。latin-1 退回用 `Buffer.toString('latin1')`。行尾空白剥除用 `/` 按行 `replace(/[ \t]+$/, '')`，不能用 `trim()`（会吃缩进）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/canonicalize.test.ts`
Expected: PASS（7 个断言全过）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(kernel): canonicalize files and read line-addressed slices"
```

---

### Task 3: 分析口径（文件选择）

**Files:**
- Create: `src/kernel/scope.ts`
- Test: `tests/scope.test.ts`
- Fixtures: `tests/fixtures/repo-small/`（含 `.gitignore`、`src/*.ts`、`dist/bundle.min.js`、`vendor/lib.js`、`package-lock.json`、`tests/fixtures/big.bin`）

**Interfaces:**
- Consumes: `Scope`、`ScopeFile`
- Produces:
  - `selectScope(root: string, opts?: ScopeOptions): Promise<Scope>`，`ScopeOptions = { subpath?: string; limits?: { maxBytes: number; maxFiles: number; maxLines: number }; extraIgnore?: string[] }`，默认上限 200MB/200_000/500_000
  - `class ScopeLimitError extends Error { dimension: 'bytes' | 'files' | 'lines'; actual: number; limit: number }`
  - `detectLanguage(path: string): string | null`——扩展名映射，只认 `ts/tsx/js/jsx/mjs/cjs/py`，其余 `null`
  - `Scope.excluded: Array<{ reason: string; count: number }>`，reason 取 `'gitignore' | 'vendored' | 'generated' | 'minified' | 'lockfile' | 'binary' | 'large-fixture'`

- [ ] **Step 1: 写失败测试**

```ts
expect(scope.files.some(f => f.path.startsWith('dist/'))).toBe(false)
expect(scope.excluded.find(e => e.reason === 'generated')!.count).toBeGreaterThan(0)
expect(scope.files.some(f => f.path === 'vendor/lib.js')).toBe(false)
expect(scope.excluded.find(e => e.reason === 'lockfile')).toBe(true)
expect(scope.byLanguage['ts']).toBeGreaterThan(0)
// 上限：直径超限要抛且说清维度
await expect(selectScope(root, { limits: { maxFiles: 1, maxBytes: 1e9, maxLines: 1e9 } }))
  .rejects.toMatchObject({ dimension: 'files' })
// subpath 不存在
await expect(selectScope(root, { subpath: 'nope' })).rejects.toThrow(/subpath/)
```

- [ ] **Step 2: 运行测试确认失败** · Run: `npx vitest run tests/scope.test.ts` · Expected: FAIL

- [ ] **Step 3: 实现 `selectScope`**

手写 `.gitignore` 的最小匹配（`ignore` 包是纯 JS 可以用）：优先用 `ignore` 包，逐目录读 `.gitignore`。排除规则按 R2 的名单硬编码：`vendor|third_party|dist|build|node_modules|*.min.*|*-lock.json|*.lock`、二进制（前 8KB 出现 `\0`）、单文件 > 1MB 且路径含 `fixtures?/`。遍历一次，边读边累计三个维度，任一超限立即抛 `ScopeLimitError`（不跑完再判）。行数用流式计数，不整文件读入。

- [ ] **Step 4: 运行测试确认通过** · Run: `npx vitest run tests/scope.test.ts` · Expected: PASS

- [ ] **Step 5: 提交** · `git commit -m "feat(kernel): select files by analysis scope"`

---

### Task 4: 取仓库、安全解压、run 目录

**Files:**
- Create: `src/kernel/acquire.ts`, `src/store/runs.ts`
- Test: `tests/acquire.test.ts`, `tests/runs.test.ts`
- Fixtures: `tests/fixtures/evil/{abs.tar,dotdot.tar,symlink.tar}`

**Interfaces:**
- Consumes: `RunManifest`
- Produces:
  - `resolveSource(input: string, opts?: { ref?: string }): Promise<ResolvedSource>`，`ResolvedSource = { kind: 'archive' | 'local'; url?: string; path?: string; ref: string; sha: string; subpath: string }`。GitHub URL 走 `https://api.github.com/repos/<o>/<r>/releases/latest` 取 tag 与 tarball 地址，失败退回默认分支 HEAD 并把抓取日期写进 `ref`（形如 `HEAD@2026-11-12`）；无网络时对本地目录用树内容 sha256 前 12 位
  - `extractTarSafe(archivePath: string, destDir: string): Promise<{ entries: number; bytes: number }>`——拒绝绝对路径、任何 `..` 段、符号链接、硬链接、设备/管道文件；拒绝前不解压该条目
  - `deriveRunId(i: { sha: string; ref: string; subpath: string; engineVersion: string }): string`——`sha256(JSON.stringify(sorted))` 前 12 位
  - `openRun(baseDir: string, manifest: RunManifest): Promise<Run>`，`Run = { dir: string; treeDir: string; write(name: string, value: unknown): Promise<void>; read<T>(name: string): Promise<T | null> }`
  - `closeRun(run: Run, opts?: { keepTree?: boolean }): Promise<void>`——默认删 `tree/`，保留 artifacts

- [ ] **Step 1: 写失败测试**

```ts
// 恶意 tar：一个字节都不许落到 destDir 之外
for (const f of ['abs.tar', 'dotdot.tar', 'symlink.tar']) {
  await expect(extractTarSafe(f, dest)).rejects.toThrow(/unsafe entry/)
}
expect(await fs.readdir(dest)).toEqual([])   // 拒绝后没有残留
// runId 稳定
expect(deriveRunId(m)).toBe(deriveRunId({ ...m }))
expect(deriveRunId({ ...m, ref: 'v2' })).not.toBe(deriveRunId(m))
// 同一 run 幂等写入
await run.write('points', [1]); await run.write('points', [2])
expect(await run.read('points')).toEqual([2])
// closeRun 删树留产物
await closeRun(run)
expect(await exists(path.join(run.dir, 'tree'))).toBe(false)
expect(await run.read('manifest')).not.toBeNull()
```

- [ ] **Step 2: 运行测试确认失败** · Run: `npx vitest run tests/acquire.test.ts tests/runs.test.ts` · Expected: FAIL

- [ ] **Step 3: 实现**

解压用系统 `tar`（`tar -xzf` 到临时目录后搬运）还是自己解？——**自己解**：需要逐条目校验。用 `zlib.gunzipSync` 拿回 tar 字节流，按 512 字节头部解析，校验每个 `name` 后再写文件。只依赖 `node:zlib`。写文件前 `path.resolve` 后必须仍以 `destDir + sep` 开头。`resolveSource` 的 fetch 通过 `deps.fetchImpl` 注入，测试不联网。

- [ ] **Step 4: 运行测试确认通过** · Run: 同上 · Expected: PASS

- [ ] **Step 5: 提交** · `git commit -m "feat(kernel): acquire archives safely and persist runs"`

---

### Task 5: profile

**Files:**
- Create: `src/kernel/profile.ts`
- Test: `tests/profile.test.ts`

**Interfaces:**
- Consumes: `Scope`、`Profile`
- Produces: `profileRepo(root: string, scope: Scope): Promise<Profile>`——`manifests` 认 `package.json|pyproject.toml|setup.py|Cargo.toml|go.mod`；`entryPoints` 从 manifest 的 `bin/main`、`src/index.*`、`__main__.py` 推断；`notes: string[]` 记录降级事实（如 `'no release tag; using HEAD@2026-11-12'`、`'python3 not found; python files unanalyzed'`）

- [ ] **Step 1: 写失败测试**

```ts
expect(profile.manifests).toContain('package.json')
expect(profile.entryPoints).toContain('src/index.ts')
expect(profile.hasTests).toBe(true)
// 空仓库不崩
expect(await profileRepo(emptyRepo, emptyScope)).toMatchObject({ manifests: [], entryPoints: [] })
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/profile.test.ts`；提交信息 `feat(kernel): profile repository shape`

---

### Task 6: structure — TypeScript/JavaScript

**Files:**
- Create: `src/kernel/structure/ts.ts`, `src/kernel/structure/index.ts`
- Test: `tests/structure-ts.test.ts`

**Interfaces:**
- Consumes: `Scope`、`StructureIndex`、`ModuleNode`、`SymbolRef`
- Produces:
  - `indexTypeScript(root: string, scope: Scope): Promise<StructureIndex>`——每个文件 `ts.createSourceFile(path, text, ScriptTarget.ES2022, true)`，遍历顶层 import/export 得边，遍历声明得符号；相对路径 `resolve` 后落成 `resolved`，包名保留 `specifier` 且 `resolved: null`
  - `mergeIndexes(indexes: StructureIndex[]): StructureIndex`——去重、累加 `unresolved`、合并 `notes`
  - `StructureIndex.notes: string[]`（本任务新增到 types）

- [ ] **Step 1: 写失败测试**

```ts
const idx = await indexTypeScript(root, scope)
expect(idx.modules.find(m => m.path === 'src/a.ts')!.imports)
  .toContainEqual(expect.objectContaining({ specifier: './b', resolved: 'src/b.ts' }))
expect(idx.modules.find(m => m.path === 'src/a.ts')!.imports)
  .toContainEqual(expect.objectContaining({ specifier: 'zod', resolved: null }))
expect(idx.symbols).toContainEqual(expect.objectContaining({ name: 'helper', kind: 'function', path: 'src/b.ts' }))
expect(mergeIndexes([{ modules: [m], symbols: [], unresolved: 1, notes: [] }, { modules: [m], symbols: [], unresolved: 2, notes: [] }]).unresolved).toBe(3)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/structure-ts.test.ts`；提交信息 `feat(kernel): build TS/JS module graph and symbol index`

---

### Task 7: structure — Python sidecar

**Files:**
- Create: `src/kernel/structure/python.ts`, `src/kernel/structure/python_index.py`
- Test: `tests/structure-python.test.ts`

**Interfaces:**
- Consumes: `Scope`、`StructureIndex`
- Produces:
  - `indexPython(root: string, scope: Scope, deps?: { pythonPath?: string }): Promise<StructureIndex>`——**一次**启动 `python3 python_index.py`，stdin 收 NDJSON `{"type":"index","files":[...]}`，stdout 逐行回 `{"path":..,"imports":[..],"symbols":[..]}`，父进程结束前发 `{"type":"exit"}`
  - sidecar 不可用时返回 `{ modules: [], symbols: [], unresolved: 0, notes: ['python3 not found; python files unanalyzed'] }`，**不抛错**
  - `python_index.py` 只用 stdlib：`ast.parse` 取 `Import/ImportFrom` 与 `FunctionDef/ClassDef/Assign`

- [ ] **Step 1: 写失败测试**

```ts
const idx = await indexPython(root, pyScope)
expect(idx.symbols).toContainEqual(expect.objectContaining({ name: 'load', kind: 'function', path: 'pkg/core.py' }))
expect(idx.modules.find(m => m.path === 'pkg/core.py')!.imports)
  .toContainEqual(expect.objectContaining({ specifier: 'os' }))
// 缺 python3 的降级
const none = await indexPython(root, pyScope, { pythonPath: '/nonexistent/python3' })
expect(none.notes).toEqual(['python3 not found; python files unanalyzed'])
expect(none.symbols).toEqual([])
// chunk 协议：一次进程处理多文件
expect(spawnCount(sidecarStub)).toBe(1)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/structure-python.test.ts`；提交信息 `feat(kernel): index python via long-lived ast sidecar`

---

### Task 8: signals — 候选信号

**Files:**
- Create: `src/kernel/signals.ts`
- Test: `tests/signals.test.ts`

**Interfaces:**
- Consumes: `Scope`、`StructureIndex`、`Candidate`、`detectLanguage`
- Produces:
  - `collectSignals(root: string, scope: Scope, structure: StructureIndex, opts?: { topK?: number }): Promise<Candidate[]>`
  - `SIGNAL_WEIGHTS: Record<SignalKind, number>`（`custom-infra: 3`, `decision-trace: 3`, `complexity: 2`, `abstraction: 2`, `evolution: 1`, `test-spec: 1`）
  - `scoreFile(file: CanonicalFile, structure: StructureIndex): Candidate[]`——纯函数，便于逐条规则测试

- [ ] **Step 1: 写失败测试**

```ts
// decision-trace：注释里的决策词命中
expect(scoreFile(f('// we chose a ring buffer instead of a queue\nconst q = []'), idx))
  .toContainEqual(expect.objectContaining({ kind: 'decision-trace', line: 1 }))
// custom-infra：手写调度器命中，调用框架的不命中
expect(scoreFile(f('class Scheduler {'), idx)).toContainEqual(expect.objectContaining({ kind: 'custom-infra' }))
// 生成的 markdown 不产生候选
expect(scoreFile(f('# README\n\nblah'), idx)).toEqual([])
// topK 截断且有序
expect((await collectSignals(root, scope, idx, { topK: 2 })).map(c => c.score)).toEqual([6, 5])
// 同一函数内的重复命中合并成一个候选
expect(scoreFile(f(dupHits), idx).length).toBe(1)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/signals.test.ts`；提交信息 `feat(kernel): score candidate signals by rule`

---

### Task 9: 内核 CLI（`ana scan`）——第一个可用切面

**Files:**
- Create: `src/commands/scan.ts`
- Modify: `src/cli.ts`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: `resolveSource`、`extractTarSafe`、`openRun`、`selectScope`、`profileRepo`、`indexTypeScript`、`indexPython`、`collectSignals`
- Produces: `runScan(input: string, opts: { out?: string; subpath?: string; ref?: string; topK?: number }): Promise<{ runId: string; candidates: Candidate[]; profile: Profile }>`——把候选与 profile 写进 run 目录，并打印前 10 个候选的 `path:line score kind`

- [ ] **Step 1: 写失败测试**

```ts
const r = await runScan(fixtureRepo, { topK: 5 })
expect(r.candidates.length).toBeGreaterThan(0)
expect(await run.read<Profile>('profile')).toMatchObject({ manifests: ['package.json'] })
expect(await run.read<Candidate[]>('candidates')).toHaveLength(r.candidates.length)
expect(stdout).toMatch(/src\/\w+\.ts:\d+ +\d+ +/)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/scan.test.ts`；提交信息 `feat(cli): add ana scan for kernel-only triage`

**此处之后软件已可用**：`ana scan <repo>` 能在不花一个 token 的情况下告诉你哪里最值得看。

---

### Task 10: 证据校验器与预算

**Files:**
- Create: `src/kernel/evidence.ts`, `src/kernel/budget.ts`
- Test: `tests/evidence.test.ts`, `tests/budget.test.ts`

**Interfaces:**
- Consumes: `LearningPoint`、`Evidence`、`ValidationResult`、`canonicalizeFile`、`lineRangeOfSnippet`
- Produces:
  - `validatePoints(points: LearningPoint[], root: string, runId: string): Promise<ValidationResult>`——三态：snippet 不在文件中或行号不覆盖 snippet → **dropped**（计入 `stats.droppedEvidence`）；`evidence` 为空或 `confidence === 'high'` 却没证据 → **downgraded** 为 `low` 并往 `unknowns` 追加 `'no verifiable evidence'`；否则 kept。`stats.evidenceRate` = kept 中 evidence 全部通过的点 / kept 总数
  - `evidenceId(runId: string, path: string, startLine: number): string`——`runId` + sha256(path+line) 前 6 位
  - `estimateTokens(ctx: { system: string; user: string }): number`——用 `tokenx` 的 `estimateTokenCount`
  - `fitCandidates(cands: Candidate[], ctxOf: (c: Candidate) => { system: string; user: string }, limit: number): { kept: Candidate[]; dropped: number }`——按 score 降序贪心装入，剩余记 `dropped`

- [ ] **Step 1: 写失败测试**

```ts
// 编造行号 → 丢弃，不崩
const r = await validatePoints([pt({ path: 'a.ts', startLine: 999, snippet: 'const x = 1' })], root, 'run1')
expect(r.dropped).toHaveLength(1)
expect(r.stats).toMatchObject({ droppedEvidence: 1 })
// 行号与 snippet 不吻合 → 丢弃
expect((await validatePoints([pt({ path: 'a.ts', startLine: 1, snippet: 'const x = 1' })], root, 'run1')).dropped).toHaveLength(1)
// CRLF 仓库仍通过（Task 2 的收益）
expect((await validatePoints([goodPt], crlfRoot, 'run1')).kept).toHaveLength(1)
// high 但无证据 → 降级
const d = await validatePoints([pt({ evidence: [], confidence: 'high' })], root, 'run1')
expect(d.downgraded[0].reason).toBe('no verifiable evidence')
expect(d.kept[0].confidence).toBe('low')
expect(d.kept[0].unknowns).toContain('no verifiable evidence')
// 预算：超限按分数裁，裁掉多少报出来
expect(fitCandidates(cands, ctxOf, 10)).toMatchObject({ dropped: expect.any(Number) })
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/evidence.test.ts tests/budget.test.ts`；提交信息 `feat(kernel): validate evidence and fit token budget`

---

### Task 11: 模型客户端与 judge

**Files:**
- Create: `src/writing/client.ts`, `src/writing/judge.ts`, `src/writing/prompts/zh.ts`
- Test: `tests/writing-judge.test.ts`

**Interfaces:**
- Consumes: `LearningPoint`、`Judgement`、`Candidate`、`Slice`、`readSlice`
- Produces:
  - `createModelClient(cfg?: { model?: string; apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch }): ModelClient`，`ModelClient = { complete(req: { system: string; user: string; schema: object }): Promise<{ json: unknown; usage: { in: number; out: number } }> }`；缺 `ANA_API_KEY` 时 `complete` 抛 `MissingCredentialsError`
  - `buildJudgePrompt(c: Candidate, slices: Slice[], lang?: 'zh' | 'en'): { system: string; user: string }`
  - `judgeCandidates(deps: { client: ModelClient; root: string; candidates: Candidate[]; lang?: 'zh' }): Promise<Judgement>`——逐候选调用，`parsePoint` 校验 JSON 形状（字段缺失就重试一次，再失败则跳过并计数）

- [ ] **Step 1: 写失败测试**

```ts
// 正常路径
const j = await judgeCandidates({ client: fakeClient({ goodPoint }), root, candidates: [c1] })
expect(j.points).toHaveLength(1)
expect(j.points[0].theirs.evidence[0].path).toBe('src/a.ts')
// 非法 JSON 不崩，且被跳过
const j2 = await judgeCandidates({ client: fakeClient('not json'), root, candidates: [c1] })
expect(j2.points).toEqual([])
// 形状不对重试一次后放弃
expect(fakeClient.callCount).toBe(2)
// 缺 key
await expect(createModelClient({ apiKey: undefined }).complete(req)).rejects.toThrow(MissingCredentialsError)
// prompt 里带上行号与片段
expect(buildJudgePrompt(c1, [slice], 'zh').user).toContain(`src/a.ts:12`)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/writing-judge.test.ts`；提交信息 `feat(writing): judge candidates into learning points`

---

### Task 12: rank 与 synthesis

**Files:**
- Create: `src/writing/rank.ts`, `src/writing/synthesis.ts`
- Test: `tests/writing-rank.test.ts`, `tests/writing-synthesis.test.ts`

**Interfaces:**
- Consumes: `LearningPoint`、`Profile`、`StructureIndex`、`ModelClient`
- Produces:
  - `rankPoints(points: LearningPoint[], candidates: Candidate[]): LearningPoint[]`——分数 = candidate.score，同主题（kind 相同且 evidence 的 path 相同）合并保留分高者；`low` 置信度一律排在有证据的后面
  - `synthesize(deps: { client: ModelClient; profile: Profile; structure: StructureIndex; titles: string[]; lang?: 'zh' }): Promise<{ problem: string; topFive: string[] }>`——**只**吃 profile + 模块图摘要 + 全部标题，不吃全文；`topFive` 必须是传入标题的子集

- [ ] **Step 1: 写失败测试**

```ts
// 合并同主题
expect(rankPoints([p1, p2SameTopic], cands)).toHaveLength(1)
// 无证据的排后面
expect(rankPoints([lowNoEvidence, highWithEvidence], cands)[0].confidence).toBe('high')
// synthesis 只吃标题：给个超长正文也必须不出现在 prompt 里
expect(lastPrompt).not.toContain('完整实现细节')
// topFive 必须是子集
expect(res.topFive.every(t => titles.includes(t))).toBe(true)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/writing-rank.test.ts tests/writing-synthesis.test.ts`；提交信息 `feat(writing): rank points and synthesize repo-level summary`

---

### Task 13: 渲染

**Files:**
- Create: `src/render/markdown.ts`, `src/render/json.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `LearningPoint`、`Profile`、`ValidationResult`
- Produces:
  - `renderMarkdown(input: { problem: string; topFive: string[]; points: LearningPoint[]; validation: ValidationResult; profile: Profile; scope: Scope; skipped: string[] }): string`
  - `renderJson(input: ReportInput): string`——与 markdown 同源数据
  - 结构：`# <repo>` → 一页纸（problem、TOP 5、可信度三数）→ 每点（层一叙述，层二"要在自己项目里用"折叠块）→ 末尾"没看的部分"

- [ ] **Step 1: 写失败测试**

```ts
const md = renderMarkdown(input)
expect(md).toContain('## 最值得学的 5 件事')
expect(md).toContain('src/a.ts:12')
expect(md).toContain('<details>')            // 配方是折叠的
expect(md).toContain('## 没看的部分')
expect(md).toMatch(/已取证点占比/)
// 没有点时照样有报告
expect(renderMarkdown({ ...input, points: [] })).toContain('没找到值得学的点')
// 片段保持原文，不被翻译
expect(md).toContain('const q = []')
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/render.test.ts`；提交信息 `feat(render): two-layer report and json output`

---

### Task 14: 接通 `ana analyze` / `report` / `inspect`

**Files:**
- Create: `src/commands/analyze.ts`, `src/commands/report.ts`, `src/commands/inspect.ts`
- Modify: `src/cli.ts`
- Test: `tests/analyze.test.ts`

**Interfaces:**
- Consumes: 全部上述模块
- Produces:
  - `runAnalyze(input: string, opts: { model?: string; apiKey?: string; topK?: number; budget?: number; lang?: 'zh' | 'en'; subpath?: string; ref?: string }): Promise<{ runId: string; reportPath: string }>`
  - `runReport(runId: string): Promise<string>`——从 run 目录重渲染，不重跑流水线
  - `runInspect(evidenceId: string): Promise<string>`——打印该 evidence 的 `path:startLine-endLine` 与原文片段

- [ ] **Step 1: 写失败测试**

```ts
const { runId, reportPath } = await runAnalyze(fixtureRepo, { model: 'x', apiKey: 'k', topK: 3, fetchImpl: fake })
expect(await fs.readFile(reportPath, 'utf8')).toContain('## 最值得学的 5 件事')
// report 不重跑流水线：删掉 tree 也能出
await closeRun(run); expect(await runReport(runId)).toContain('# ')
// inspect 定位
expect(await runInspect(evId)).toContain('src/a.ts:12-14')
// 未知 runId
await expect(runReport('deadbeef')).rejects.toThrow(/no such run/)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/analyze.test.ts`；提交信息 `feat(cli): wire analyze, report and inspect`

---

### Task 15: 端到端与评测骨架

**Files:**
- Create: `src/commands/analyze.ts` 的降级分支（空仓库）
- Create: `eval/gold/<repo>.json`（10 个）、`eval/run.ts`
- Test: `tests/e2e.test.ts`, `tests/eval-match.test.ts`

**Interfaces:**
- Consumes: `runAnalyze`、`LearningPoint`
- Produces:
  - `matchGold(produced: LearningPoint[], gold: GoldPoint[]): { recall: number; matched: string[] }`——同 `path` 且行区间相交，或符号名相同即命中（R10）
  - `eval/run.ts` 输出 `{ recall, evidenceRate, droppedEvidence }` 表；gold 文件形如 `{ repo, ref, sha, points: [{ path, startLine, endLine, why }] }`

- [ ] **Step 1: 写失败测试**

```ts
// 位置重叠算命中
expect(matchGold([pt({ path: 'a.ts', startLine: 12, endLine: 14 })], [{ path: 'a.ts', startLine: 13, endLine: 20 }]).recall).toBe(1)
// 相邻但不相交不算
expect(matchGold([pt({ path: 'a.ts', startLine: 12, endLine: 14 })], [{ path: 'a.ts', startLine: 20, endLine: 30 }]).recall).toBe(0)
// 空仓库照常出报告，说清为什么没点
expect(await runAnalyze(emptyRepo, opts)).toMatchObject({ reportPath: expect.stringContaining('report.md') })
expect(await fs.readFile(path, 'utf8')).toContain('没找到值得学的点')
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/e2e.test.ts tests/eval-match.test.ts`；提交信息 `test: add eval matching and empty-repo e2e`

---

## Self-Review

**1. Spec coverage**：§7.1 分层 → 任务顺序即分层（1–9 内核、10–12 写作、13 渲染、14 外壳）；§7.2 四段 → Task 4/3/6-7/8；§7.3 类型 → Task 1；§7.4 校验 → Task 10；§7.5 三段写作与上下文预算 → Task 11-12 + Task 10 的 `fitCandidates`；§7.6 渲染与语言 → Task 13 + Global Constraints；§7.7 外壳 → Task 9/14（MCP server 与 publish 不在本计划，见下）；§7.8 评测 → Task 15；R1-R11 落在文件名对应的任务步骤里。

**2. Step scan**：删掉了两处"handle edge cases"式空话，改成具体断言（空仓库、畸形 tar、缺 python3）。每个实现步骤给了签名和行为边界，没写函数体（除 tar 解析这一处算法，签名和测试无法确定其字节头布局）。

**3. Type consistency**：`StructureIndex` 在 Task 6 新增 `notes` 字段，Task 1 的 types 已同步声明；`Evidence.id` 由 Task 10 的 `evidenceId` 生成并在 Task 13 渲染；`Candidate.matched` 在 Task 8 写入、Task 12 只读；`Judgement` 由 Task 11 产出、Task 12 消费。

**4. Review Focus**：五条都有归属——1→Task 2（CRLF/BOM/latin-1 三个 fixture）、2→Task 4（三个恶意 tar）、3→Task 11（非法 JSON、重试、跳过）+ Task 10（编造行号丢弃）、4→Task 15（空仓库）、5→Task 7（缺 python3）+ Task 5（无 tag 的 notes）+ Task 3（subpath 不存在）。

**5. Proportion**：本计划比 spec 长，但长在测试断言和接口签名上，没有长在函数体上。凡是能在 spec 里一句话说清的，计划里没有复述。

## 本计划不做

MCP server（6 个工具与 `submit_points`）、`ana publish`、`bytecode`/其他语言、跨运行索引缓存。这些是下一份计划的范围——先确认"点够不够好"，再扩分发面。
