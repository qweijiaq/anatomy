### Task 4: 取仓库、安全解压、run 目录

**Files:**
- Create: `src/kernel/acquire.ts`, `src/store/runs.ts`
- Test: `tests/acquire.test.ts`, `tests/runs.test.ts`
- Fixtures: `tests/fixtures/evil/{abs.tar,dotdot.tar,symlink.tar}`

**Interfaces:**
- Consumes: `RunManifest`
- Produces:
  - `resolveSource(input: string, opts?: { ref?: string }): Promise<ResolvedSource>`，`ResolvedSource = { kind: 'archive' | 'local'; url?: string; path?: string; ref: string; sha: string; subpath: string }`。GitHub URL 走 `https://api.github.com/repos/<o>/<r>/releases/latest` 取 tag 与 tarball 地址，失败退回默认分支 HEAD 并把抓取日期写进 `ref`（形如 `HEAD@2026-11-12`）；无网络时对本地目录用树内容 sha256 前 12 位
  - `extractTarSafe(archivePath: string, destDir: string): Promise<{ entries: number; bytes: number }>`——拒绝绝对路径、任何 `..` 段、符号链接、硬链接、设备/管道文件；拒绝前不解压该条目
  - `deriveRunId(i: { sha: string; ref: string; subpath: string; engineVersion: string }): string`——`sha256(JSON.stringify(sorted))` 前 12 位
  - `openRun(baseDir: string, manifest: RunManifest): Promise<Run>`，`Run = { dir: string; treeDir: string; write(name: string, value: unknown): Promise<void>; read<T>(name: string): Promise<T | null> }`
  - `closeRun(run: Run, opts?: { keepTree?: boolean }): Promise<void>`——默认删 `tree/`，保留 artifacts

- [ ] **Step 1: 写失败测试**

```ts
// 恶意 tar：一个字节都不许落到 destDir 之外
for (const f of ['abs.tar', 'dotdot.tar', 'symlink.tar']) {
  await expect(extractTarSafe(f, dest)).rejects.toThrow(/unsafe entry/)
}
expect(await fs.readdir(dest)).toEqual([])   // 拒绝后没有残留
// runId 稳定
expect(deriveRunId(m)).toBe(deriveRunId({ ...m }))
expect(deriveRunId({ ...m, ref: 'v2' })).not.toBe(deriveRunId(m))
// 同一 run 幂等写入
await run.write('points', [1]); await run.write('points', [2])
expect(await run.read('points')).toEqual([2])
// closeRun 删树留产物
await closeRun(run)
expect(await exists(path.join(run.dir, 'tree'))).toBe(false)
expect(await run.read('manifest')).not.toBeNull()
```

- [ ] **Step 2: 运行测试确认失败** · Run: `npx vitest run tests/acquire.test.ts tests/runs.test.ts` · Expected: FAIL

- [ ] **Step 3: 实现**

解压用系统 `tar`（`tar -xzf` 到临时目录后搬运）还是自己解？——**自己解**：需要逐条目校验。用 `zlib.gunzipSync` 拿回 tar 字节流，按 512 字节头部解析，校验每个 `name` 后再写文件。只依赖 `node:zlib`。写文件前 `path.resolve` 后必须仍以 `destDir + sep` 开头。`resolveSource` 的 fetch 通过 `deps.fetchImpl` 注入，测试不联网。

- [ ] **Step 4: 运行测试确认通过** · Run: 同上 · Expected: PASS

- [ ] **Step 5: 提交** · `git commit -m "feat(kernel): acquire archives safely and persist runs"`

---

