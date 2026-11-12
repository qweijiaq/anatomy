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

