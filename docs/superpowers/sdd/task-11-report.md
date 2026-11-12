# Task 11 report — judge layer (`src/writing/judge.ts`, `src/writing/client.ts`)

## Built

- `src/writing/judge.ts` — `judgeCandidates(deps)`: bounded context slices (own window
  `line-12 .. line+60`, imports head, up to two direct relative dependencies), the zh/en prompt
  from `prompts/zh.ts`, strict reply shape checking, one repair retry, transport failures surfaced
  not retried, then `validatePoints` always.
- `src/writing/client.ts` — `createModelClient()`: injected `fetch`, credentials resolved at call
  time, bounded 429/5xx/network retry budget, `ModelReplyError` separated from
  `ModelRequestError`.
- `tests/writing-judge.test.ts` — prompt rendering, request building, client retry matrix, judge
  outcomes.

## Fix round 1

Review findings 1-8, fixed in one round on top of `a91a527`.

### 1 [Critical] A citation outside the shown window could back a point

- The slices handed to `buildJudgePrompt` are now kept and turned into
  `Map<path, Array<[startLine, endLine]>>` by `shownWindows(slices)`; `shownRanges(slice)` returns
  the slice's visible span and, for a truncated slice, the head span `startLine..omitted.startLine-1`
  and the tail span `omitted.endLine+1..endLine`, so an elided range is never a shown range.
- `keepShownEvidence(point, windows)` runs inside the per-candidate loop after the reply is parsed:
  every evidence item whose cited range is not fully inside one shown range of that path is dropped.
  A point that loses all its evidence is passed on with `evidence: []`, so Task 10 downgrades it
  instead of a fabricated citation reaching the report.
- Citations are matched on `citationKey(path)` (posix, `path.posix.normalize`, leading `./`
  stripped), so a differently spelled path cannot slip through and a differently spelled citation
  fails closed.
- Prompt files touched: none. The "cite only what was shown" rule stays advisory; it is now also
  enforced.

### 2 [Important] Every slice re-decoded the whole file

- `canonicalize.ts` gained `sliceOf(file, startLine, endLine, opts)`, the pure slicing half of
  `readSlice`; `readSlice` is now `sliceOf(await canonicalizeFile(abs), …)`, so there is still one
  implementation of "what is a slice".
- `judgeCandidates` builds one `JudgeContext` per run with `files: Map<absPath, Promise<CanonicalFile>>`
  and every window (imports head, own window, each dependency) is cut with `sliceOf` from that one
  decode. A 30-candidate file now costs one decode, not 60.

### 3 [Important] Out-of-tree bytes could be uploaded

- `realFileInside(ctx, abs)` resolves `realpath(abs)`, requires `isInside(ctx.realRoot, real)` and
  requires `(await stat(real)).isFile()`. `realRoot` is `realpath(path.resolve(deps.root))` taken
  once per run. `contextSlices` throws for a candidate that fails it (reported as skipped) and
  `dependencySlices` skips a dependency that fails it, both before any read. `realpath`/`stat`
  answers are cached per spelled path.
- The `stat` on the realpath also keeps a symlink to a FIFO from hanging the run, which the lexical
  check could not.

### 4 [Important] No request timeout

- `ModelClientConfig.timeoutMs` (default `DEFAULT_TIMEOUT_MS = 60_000`) arms a fresh
  `AbortSignal.timeout(timeoutMs)` per attempt — a signal created once outside the retry loop would
  already be aborted when a retry is sent.
- `isAbortError(error)` accepts both `AbortError` (provider/proxy abort) and `TimeoutError`
  (`AbortSignal.timeout`'s reason) and surfaces them as
  `ModelRequestError('model request timed out after <ms>ms', { retryable: true })`, so the 429/5xx
  budget engages instead of the CLI hanging.

### 5 [Minor] `root: '.'` broke dependency resolution

- `createContext` resolves the root once. `repoRelative`, `resolveSpecifier`, `dependencySlices`,
  `contextSlices` and `validatePoints` all receive `ctx.root`, so no path is resolved against a
  different root than the one `repoRelative` used.

### 6 [Minor] Dependency slices ignored the analysis scope

- `ctx.inScope` is `Set(scope.files.path)` (or `null` without a scope); `dependencySlices` skips any
  resolved dependency not in it, so excluded or vendored code is neither uploaded nor invited as
  evidence.

### 7 [Minor] Evidence ids were minted from a fake run id

- `JudgeDeps.runId` is required (no `'judge'` fallback) and is forwarded unchanged to
  `validatePoints`. Every call site in `tests/writing-judge.test.ts` now passes `runId: 'run-1'`
  (`'run-7'` in the id test).

### 8 [Minor] Provider error bodies leaked into reports

- The non-OK branch no longer reads or copies `response.text()`: the failure is
  `model request failed: HTTP <status>` with `status` set. The status is the only part of a provider
  failure that is ours to publish.

## Tests

New in `tests/writing-judge.test.ts` (12 tests, 375 → 387):

- `judgeCandidates — a citation outside the shown window cannot back a point`
  - `drops the unseen line and keeps the citation the model actually read`: a point citing
    `src/wide.ts:200` (a real, verifiable snippet) and `src/wide.ts:12-14` (inside the shown window
    `1..72`) keeps exactly the shown item.
  - `downgrades a point whose only evidence is a real snippet on an unread line`: same unseen
    citation alone → `evidence: []`, `confidence: 'low'`, `validation.dropped: []`,
    `validation.downgraded` has one entry.
- `judgeCandidates — slices come from one decode per file`
  - `canonicalizes each file once even when several candidates share it`: `vi.mock`s
    `canonicalizeFile` with a counting delegate; two candidates in `src/a.ts` (whose import resolves
    to `src/b.ts`) produce exactly `['a.ts', 'b.ts']`.
- `judgeCandidates — out-of-tree bytes never reach the provider`
  - `does not read a dependency that resolves through a symlink out of the root`: `src/importer.ts`
    imports `./leak.js`, `src/leak.ts -> <tmp>/credentials.ts`; the prompt must not contain the
    sentinel and no canonicalization of the outside path may happen.
  - `skips a candidate whose own path is a symlink out of the root`: no client call, one skip
    whose reason names "outside".
- `judgeCandidates — the analysed root and scope bound the slices`
  - `keeps dependency slices when the root is spelled "."` (`process.cwd` stubbed to the fixture
    root; guards the resolve-once change).
  - `never shows a dependency the scope excluded`: scope `['src/a.ts']` → `src/b.ts` content absent
    from the prompt.
- `judgeCandidates — ids name the caller run`: evidence id matches `/^run-7-[0-9a-f]{6}$/`.
- `createModelClient — deadlines and error bodies`
  - `sends an abort signal with every request` (`init.signal instanceof AbortSignal`);
  - `treats a stalled request as a retryable timeout instead of hanging forever` (fetch that only
    settles on abort, `timeoutMs: 10`, `maxRetries: 0` → retryable `ModelRequestError`, message
    matches `/timed out/`, `status: null`);
  - `retries an AbortError from the provider instead of failing the run` (2 fetch attempts);
  - `keeps the provider status but never copies its error body into the failure` (500 body
    `sk-live-provider-token leaked` → message has `HTTP 500`, not the token).

Test fixtures added: an outside temp dir with `credentials.ts` (`AKIA-DO-NOT-SEND`),
`src/leak.ts` symlinked to it, `src/importer.ts` importing it, and an explicit `canonicalizeFile`
counter mock (same pattern as `tests/evidence.test.ts`).

`tests/evidence.test.ts` was not modified: findings 1-8 are all in the judge and client layers, and
Task 10's validator already realpaths and scopes.

## RED / GREEN

- RED (tests written first, no source change yet):
  `npx vitest run tests/writing-judge.test.ts` →
  `Tests 9 failed | 33 passed (42)`, `Test Files 1 failed (1)`. Failures, in order:
  drops-the-unseen-line, downgrades-only-unseen, canonicalizes-once, dependency-symlink,
  candidate-symlink, scope-excluded-dependency, abort-signal, stalled-timeout (5s test timeout),
  provider-body. The two findings that are enforced by the type system rather than behaviour
  (`runId` required, root resolved once) are covered by `npm run typecheck` and the `root: '.'`
  regression test respectively.
- GREEN after the fix: `npx vitest run tests/writing-judge.test.ts` → `42 passed (42)`.
- Full suite: `npm test` → `Test Files 14 passed (14)`, `Tests 387 passed (387)`, no stderr output.
- Types: `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.test.json`) → clean.

## Concerns

1. Finding 5 is latent, not observable. `path.resolve`. `path.relative` and `repoRelative` all
   normalize against `process.cwd()`, so a relative root already behaved consistently in the paths
   I could reach; the test pins the behaviour rather than demonstrating a broken case. The fix
   (resolve once) is what the finding asked for and removes the class of bug.
2. `judgeCandidates` still re-decodes a file that Task 10 then canonicalizes again for validation
   (the judge's cache is per run, the validator's is per call). Sharing one cache across both would
   couple the two modules; the decode is now one per file per stage, which is what both findings
   asked for.
3. `keepShownEvidence` compares path spellings lexically. A model that cites `src/./a.ts` or a
   symlinked spelling of a shown file now loses that evidence (fail-closed). No test pins the
   permissive spelling because the prompt only ever shows repo-relative posix paths.
4. The timeout test depends on a real 10 ms timer. It is deterministic (the fetch only settles on
   abort) but adds ~10 ms to the suite.
