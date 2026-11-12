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

