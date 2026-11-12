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

