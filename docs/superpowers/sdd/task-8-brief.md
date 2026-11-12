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

