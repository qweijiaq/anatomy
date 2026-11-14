# Working on this repository

`anatomy` surveys a repository and writes a report about how it actually flows — one
dataset rendered three ways (terminal markdown, a file, and the desktop window).

This file is for anyone — human or agent — who needs to establish the repository's
state without reading all of `src/` first.

## Is this done?

`docs/DONE.md` enumerates the twelve conditions under which this project is finished,
each with a command and a file to check it against, plus the four things deliberately
left out. That is the file to read if the question is "should any more work happen".

For the mechanical half, read `docs/superpowers/audit-output.txt` — the last recorded eight-line verdict, with
the commit it belongs to in its header — or run `npm run audit` for a fresh one. The
last line is either `AUDIT: READY` or the checks that failed. That file exists because
the answer should not cost more to obtain than the project costs to read.

## Establish the state

```bash
npm run audit       # one command, eight computed lines, one verdict
npm run typecheck   # three configs: src, tests+eval, renderer+electron
npm run test        # ~760 tests, no network
npm run verify      # the gate: tests, typecheck, build, then the CLI end to end
```

`audit` runs `verify` and then states the rest: whether the tree is the commit that
was pushed, whether generated output is tracked, whether the documentation's numbers
still describe the suite, and whether anything is left as a TODO. Start there — it
answers "what condition is this in" in one call, and every line is measured.

`npm run verify:record` also writes the run into `.ana/` under a neutral name, so the
claim "verify passed" has a receipt instead of a memory.

`ana` is this package's `bin`; `npm install` does not put it on PATH. Use
`node dist/cli.js` (after `npm run build`) or `npm link` once.

`.ana/` holds every stored run and is **not** tracked either — it is local state, and
it grows one directory per analysis. `ana forget --keep 3` keeps the three newest and
deletes the rest; `ana forget <id>` removes one by name. When reading this repository,
ignore `.ana/` and `.superpowers/`: neither is part of it.

`npm run build` and `npm run build:desktop` produce output that is **not** tracked:
`dist/`, `dist-renderer/`, `dist-electron/`, `out/`. A clean checkout has none of it,
and nothing in `src/` reads it. `npm run clean` removes it.

## What must stay true

- **One write path.** Every source of a point — the model's survey and the repo
  scan — writes through the same accounting, so the cost of an analysis never
  depends on which provider produced it.
- **Evidence resolves.** A report's claim cites `path:line`, and `ana inspect`
  re-reads the file and reports whether it still matches. A claim whose evidence does
  not resolve is a claim this project does not make.
- **The gate guards itself.** `scripts/verify.sh` covers the sections below, and a
  test fails if a section is removed. Adding a claim to the docs without a check is
  the failure mode this repository has spent the most effort on.
- **Numbers in the docs are measured.** `55/90 = 61%` recall, `0.1.0`, the test count
  — each comes from a command in this file or from `git`. If a change moves one, the
  command that shows it moves in the same commit.

## What is claimed, and what proves it

Every row is checkable without trusting this file. The left column is what the project
says about itself; the right column is where that claim can be falsified.

| Claim | Falsified by |
|---|---|
| 798 tests pass in 36 files | `npm test`, or `docs/superpowers/verify-output.txt` for the recorded run |
| Typecheck is clean in three configs | `npm run typecheck` (src, tests+eval, renderer+electron) |
| The CLI works end to end with no API key | `npm run verify` — `scripts/verify.sh`, twelve sections, local stub model |
| Every citation points at the line it names | `tests/evidence.test.ts`; `ana inspect <path:start-end>` re-reads it |
| The analysed repository's code is never executed | `tests/structure-python.test.ts`, `tests/acquire.test.ts` |
| The documentation's numbers match the artifacts | `tests/docs-consistency.test.ts`, and the `docs` line of `npm run audit` |
| The window's bridge cannot drift from the preload | `tests/packaging.test.ts` |
| The MCP server serves four tools | `tests/mcp.test.ts`, and the `mcp` section of the gate |
| A clean checkout reproduces all of it | `docs/superpowers/EVIDENCE.md`, section "Clean checkout" |
| Candidate recall is 61% | `npm run eval:recall` — 55 of 90 annotated points |

If a row here and a command disagree, the command is right and this file is the defect.

## Where the reasoning lives

- `docs/DONE.md` — the twelve conditions that define "finished", and what is out of scope.
- `docs/superpowers/PROGRESS.md` — what was built and why, in order.
- `docs/superpowers/EVIDENCE.md` — what each claim rests on.
- `docs/superpowers/specs/2026-11-12-anatomy-design.md` — the design: the data flow from
  `survey` to `synthesize` to a report, and the decisions behind it.
- `docs/desktop.md` — the window, what it deliberately does not do, and why.
- The rulings that had alternatives are in the design spec above, under its decisions
  section; there is no separate `decisions/` directory, and saying there was cost a
  reader a lookup that returned nothing.

## Known limits, stated rather than hidden

- The window does not run the slow acquisition. That belongs to the CLI; the window
  reads what is already on disk, which is why every click in it is instant.
- No packaged `.dmg`. `npm run build:bundle` produces a local `out/anatomy.app`.
- Candidate recall is 61% — the ceiling for this approach, measured, not estimated.
