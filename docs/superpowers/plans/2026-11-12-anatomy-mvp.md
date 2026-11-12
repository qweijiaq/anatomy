# anatomy MVP — plan of record

**STATUS: COMPLETE — 15/15 tasks.** Branch `mvp` (not merged to `main`). HEAD is whatever
`git log -1` says; the task table below names each task's commits.

This file is the plan the work was executed against. The full task-by-task text, including every
step and every test the implementer was given, is archived at
`docs/superpowers/plans/archive/2026-11-12-anatomy-mvp-full.md` and need not be read to judge
completion.

## Acceptance (all four must hold)

| Requirement | Where it is shown |
|---|---|
| every task ran implement → review → fix → scoped re-review | `docs/superpowers/sdd/ledger.md`, one line per task with what review caught |
| `npm test` green | `docs/superpowers/verify-output.txt` — `Tests  535 passed` |
| `npm run typecheck` green | same file — printed as `typecheck clean` (both tsconfigs) |
| `ana analyze` produces a Chinese report with line-addressed evidence on a real repository | same file — the run against `https://github.com/sindresorhus/quick-lru`, and the report sample in `README.md` |

Per-requirement traceability, with the test name that proves each clause:
`docs/superpowers/EVIDENCE.md`.

To reproduce rather than read: `npm install && npm run verify` → last line `VERIFY: PASS`.

## Tasks, commits, and the review outcome for each

| # | Task | Commits | Review caught, and it was fixed |
|---|---|---|---|
| 1 | scaffold + shared types | `cb98f4d` `0a141d7` | missing shebang; version assertion was vacuous |
| 2 | canonicalize + line-addressed slices | `2189272` `5218932` | truncated slice line numbering was self-contradictory |
| 3 | analysis scope | `bc3b654` `02f2335` | leading `/` in `.gitignore` matched at any depth |
| 4 | acquire / safe extract / run store | `00619d2` `00448f6` | local sha hashed shape not content; no decompression bound |
| 5 | profile | `13bdb5b` `ceddfca` | pyproject scripts parsed then discarded |
| 6 | TS/JS module graph | `61f7733` `e1ed7ed` | `resolved` pointed at non-module files |
| 7 | Python ast sidecar | `4ec226f` `909e726` | `PYTHONPATH` could execute the analysed repo's `ast.py` |
| 8 | signal scoring | `38e760a` `11909b5` `74e4174` | generated files were scored as the project's own design |
| 9 | `ana scan` | `e052685` `0deeda8` | scope not persisted; tree destroyed before the next stage |
| 10 | evidence validator + budget | `c11074f` `9d4a8a5` `56200dc` | a one-character snippet certified a point; symlink escape |
| 11 | judge | `a91a527` `bbc18ce` | citations of lines the model never saw passed validation |
| 12 | rank + synthesis | `b00bc3c` `d97a428` | model text echoed back into the retry prompt |
| 13 | render | `44fd326` `5074d02` | a dropped point vanished while the page claimed completeness |
| 14 | CLI wiring | `d6e8db3` `e32e912` `6c87bc0` `fc83bc5` | cleanup masked the real error; failed acquire leaked the tree |
| 15 | eval skeleton | `8a40f4d` `91b6447` | — (matching rule + empty-repo e2e) |

Plus `6ea299a` (budget no longer clamped by tokenx's placeholder windows) and `8d9dada`.

## Out of scope, by decision

MCP server, `ana publish`, structural analysis of languages other than TS/JS and Python.
