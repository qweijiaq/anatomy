
## Committed by controller

Two dispatches: 14A wrote `src/commands/analyze.ts` (commit d6e8db3); 14B wrote `report.ts`/`inspect.ts` and their tests but stopped before wiring `src/cli.ts`, leaving 10 failing tests. The controller added `ANALYZE_USAGE` and `parseAnalyzeArgs` and wired all three commands in `src/cli.ts`, then committed. `npm test` 496 passed / 20 files, `npm run typecheck` clean.

## Fix round 1

Four review defects in `runAnalyze`, fixed test-first in `tests/analyze.test.ts` (five new cases, all red before the change).

1. **Cleanup masks the real error.** The `finally` now returns rather than throws its cleanup failure: `closeSafely(run)` wraps `closeRun` into an `Error` with the `rm`/guard failure as *its* cause, and the run's own failure is captured in a `catch` first. If nothing else was in flight the cleanup error is thrown as before; otherwise the original error is rethrown with the cleanup failure attached as its `cause` (when it already had one, both are aggregated into an `AggregateError` whose `cause` is the original). The message a reader sees is still the stage error. Test: a `Run` whose `closeRun` throws (module-level `vi.mock` of `src/store/runs.js`, delegating by default so only the analyze-level close is refused) plus a client that throws `MissingCredentialsError` — the rejection message still contains the stage cause and carries `EPERM` as `cause`.

2. **A failed acquire leaked the tree.** `scanRepo` opens the run and extracts `tree/` *before* it can throw (a bad `subpath` dies in `selectScope`), and on that path it returns no handle, so the old shape — `scanRepo` outside the `try` — never reached the `finally`. `run` is now a nullable local assigned from a new `PipelineOptions.onRun` hook (called immediately after `openRun`, before any stage) as well as from the successful result, and the `finally` closes whatever it holds, tolerating `null`. Test: `subpath: 'no-such-directory'` rejects and no `tree/` survives under `baseDir`.

3. **Provider text was persisted verbatim.** Reasons reaching `skipped.json` and the report tail now pass through `redactReason`: `sk-…` keys, `authorization`/`api_key`/`key=`-style `keyword<sep>value` fragments, and any bare 32+ character token run are replaced with `[redacted]`, and the result is whitespace-collapsed and capped at 200 chars. Redaction happens on the single `skipped` array that both sinks read, so neither can drift. Test: a client whose first call throws `provider echoed GET /v1/messages?api_key=sk-abc123` — `skipped.json` and `report.md` contain no `sk-abc123`, and the entry still names the provider failure.

4. **No completion marker.** `stampStatus(run, 'failed')` runs as soon as the scan returns (the scan's own `complete` only covers its four artifacts, and a run that owes a report is not done), and `stampStatus(run, 'complete')` runs only after `persist` has written `report.md`, setting `completedAt`; a failure deletes any inherited `completedAt`. Tests: a successful run's manifest is `complete` with a `completedAt` and its report on disk; a run that dies in the judge is left `failed` with no `completedAt`.

`npm test`: 501 passed / 20 files. `npm run typecheck`: clean.

## Real-repository defect round (controller)

An end-to-end run against `https://github.com/sindresorhus/quick-lru` (with a local OpenAI-shaped stub) exposed two defects no unit test covered:

1. **Archive wrapper kept in every path.** GitHub tarballs wrap the project in `<owner>-<repo>-<sha>/`, so `scope.root` was the extraction directory and every path read `sindresorhus-quick-lru-29bdd4c/index.js`. Fix: `materialize` unwraps a single top-level directory (never when `--subpath` is given) and records it in `manifest.treeRoot`.
2. **The report was titled `# tree`.** `ReportInput` had no source (the Task 1 deferral), so the heading fell back to the root's basename. Fix: `ReportInput.source`, a `来源：` line in the 口径 block, and the title derived from the source's last path segment.

The subagent stopped mid-change; the controller finished the type threading, the render/report/analyze wiring and the test fixtures. `npm test` 501 passed, `npm run typecheck` clean.
