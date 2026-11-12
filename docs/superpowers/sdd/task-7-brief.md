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

