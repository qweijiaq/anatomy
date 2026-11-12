# SDD ledger — plan: docs/superpowers/plans/2026-11-12-anatomy-mvp.md

REPO: /Users/weijia/Desktop/anatomy (symlinked at ~/.x-code/workspace/anatomy)
STATUS: complete. Plan tasks 15/15 (Task 1-5 done earlier in the same branch, Task 6-15 in this run).
Branch `mvp`, NOT merged to main. Every task went implement → code-reviewer → fix → scoped re-review.

## Verify (one command, that is the whole acceptance)

```
npm run verify
```

Last line must read `VERIFY: PASS (github, run <id>)`. It asserts, in order:
`npm test` 535 passed / 23 files · `npm run typecheck` clean on both tsconfigs · `npm run build` ok ·
`ana scan https://github.com/sindresorhus/quick-lru` returns `path:line` candidates ·
`ana analyze` writes a Chinese report containing a title, `已取证点占比`, `没看的部分` and a
`` `path:start-end` `` citation line · `ana report` re-renders after the extracted tree is deleted ·
`ana inspect <evidenceId>` prints the range and source.
The model is the committed local stub `scripts/verify-stub.mjs` (no provider key needed, deterministic);
citations are still checked against the bytes on disk by the product's own validator.
A committed transcript of a real run: `docs/superpowers/verify-output.txt`.
Which test proves which acceptance clause, by name: `docs/superpowers/EVIDENCE.md`.

## Task 6-15, one line each (with the review outcome)

- T6 TS/JS module graph + symbols — 2 Important (resolution to non-module paths; deny-list holes) fixed.
- T7 Python ast sidecar — 1 Critical (PYTHONPATH could execute the analysed repo's `ast.py`) + 3 fixed.
- T8 signal scoring — 1 Critical (generated files scored) + 4 Important; round 2 caught 2 regressions, fixed.
- T9 `ana scan` — 3 Important (scope not persisted; tree destroyed before stage 2; failed re-run looked complete) fixed.
- T10 evidence validator + budget — 8 Important over 2 rounds (1-char snippet, duplicate-code false drop, symlink escape, unbounded read, malformed point reaching the renderer, non-upper-bound estimate) fixed.
- T11 judge — 1 Critical (citations of lines the model was never shown passed validation) + 3 fixed.
- T12 rank + synthesis — 2 Important (model text echoed into the retry prompt; affinity borrowed from unrelated files) fixed.
- T13 render — 2 Important (a dropped point vanished while the page claimed completeness; TOP-5 named withheld points) fixed.
- T14 CLI wiring — 3 + 1 Critical out of a focused review (cleanup masked the real error; failed acquire leaked the tree; provider text persisted unredacted) fixed.
- T15 eval skeleton — `matchGold`/`readGold`, 3 gold sets, `eval/run.ts`, empty-repo e2e.

Three more fixes landed after the plan closed, all from recorded review findings: `hashTree` now digests
the analysed scope (a gitignored local cache no longer mints a new run id), chained `it.each` tables keep
their assertion density (a real candidate-loss bug), and a nested `anatomy:` prefix is collapsed.

Two report-honesty fixes: `.git` is now reported as its own `vcs` exclusion
reason instead of `vendored` (the header prints these counts verbatim), and a nested `anatomy:` prefix
is collapsed so the CLI never prints `ana: anatomy: ...`.

## Rulings that shaped the work

- R7: implementer subagents stop near the end, so when one did, the controller inspected the tree,
  committed it if green, and did not re-dispatch (re-dispatch costs 1.5-2.5M tokens for nothing).
- Evidence must never be validated from the model's own text: one `canonicalizeFile` produces both the
  text shown to the model and the text compared against disk.
- `validatePoints` must not use `offsetOfLine` throwing as a bounds check (it has one extra addressable
  line start for text ending in `\n`); assert `1 <= start <= end <= lineCount` explicitly.
- The judge must keep the ranges it showed and drop citations outside them, or "cite only what you were
  shown" is advisory only.

## Found by running it, not by review (all fixed)

archive wrapper directory kept in every path · report titled `# tree` · `clampBudget` trusting tokenx's
placeholder windows (4097/8192) and cutting a 100k budget to 4k · judged run discarded when synthesis
failed.

## Deferred (recorded, not fixed)

Budget-aware `countLines` abort; `.git` labelled `vendored`; `hashTree` ignores `.gitignore`;
`it.each` chained form loses assertion density; judge and validator decode a file once each;
unresolved-entry notes not de-duplicated.

Full per-task record: `docs/superpowers/sdd/ledger.md` (also the briefs and reports under `docs/superpowers/sdd/`).
Status page: `docs/superpowers/PROGRESS.md`. Root entry point: `README.md`.
