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

