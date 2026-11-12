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

