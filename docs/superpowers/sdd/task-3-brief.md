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

