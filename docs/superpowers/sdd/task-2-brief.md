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

