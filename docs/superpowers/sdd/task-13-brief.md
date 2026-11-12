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

