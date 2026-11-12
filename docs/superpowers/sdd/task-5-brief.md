### Task 5: profile

**Files:**
- Create: `src/kernel/profile.ts`
- Test: `tests/profile.test.ts`

**Interfaces:**
- Consumes: `Scope`、`Profile`
- Produces: `profileRepo(root: string, scope: Scope): Promise<Profile>`——`manifests` 认 `package.json|pyproject.toml|setup.py|Cargo.toml|go.mod`；`entryPoints` 从 manifest 的 `bin/main`、`src/index.*`、`__main__.py` 推断；`notes: string[]` 记录降级事实（如 `'no release tag; using HEAD@2026-11-12'`、`'python3 not found; python files unanalyzed'`）

- [ ] **Step 1: 写失败测试**

```ts
expect(profile.manifests).toContain('package.json')
expect(profile.entryPoints).toContain('src/index.ts')
expect(profile.hasTests).toBe(true)
// 空仓库不崩
expect(await profileRepo(emptyRepo, emptyScope)).toMatchObject({ manifests: [], entryPoints: [] })
```

- [ ] **Step 2–5: 失败 → 实现 → 通过 → 提交**

Run: `npx vitest run tests/profile.test.ts`；提交信息 `feat(kernel): profile repository shape`

---

