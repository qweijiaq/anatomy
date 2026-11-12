### Task 9: 内核 CLI（`ana scan`）——第一个可用切面

**Files:**
- Create: `src/commands/scan.ts`
- Modify: `src/cli.ts`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: `resolveSource`、`extractTarSafe`、`openRun`、`selectScope`、`profileRepo`、`indexTypeScript`、`indexPython`、`collectSignals`
- Produces: `runScan(input: string, opts: { out?: string; subpath?: string; ref?: string; topK?: number }): Promise<{ runId: string; candidates: Candidate[]; profile: Profile }>`——把候选与 profile 写进 run 目录，并打印前 10 个候选的 `path:line score kind`

- [ ] **Step 1: 写失败测试**

```ts
const r = await runScan(fixtureRepo, { topK: 5 })
expect(r.candidates.length).toBeGreaterThan(0)
expect(await run.read<Profile>('profile')).toMatchObject({ manifests: ['package.json'] })
expect(await run.read<Candidate[]>('candidates')).toHaveLength(r.candidates.length)
expect(stdout).toMatch(/src\/\w+\.ts:\d+ +\d+ +/)
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/scan.test.ts`；提交信息 `feat(cli): add ana scan for kernel-only triage`

**此处之后软件已可用**：`ana scan <repo>` 能在不花一个 token 的情况下告诉你哪里最值得看。

---

