# Working on this repository

`anatomy` surveys a repository and writes a report about how it actually flows — one
dataset rendered three ways (terminal markdown, a file, and the desktop window).

This file is for anyone — human or agent — who needs to establish the repository's
state without reading all of `src/` first.

## Establish the state

```bash
npm run typecheck   # three configs: src, tests+eval, renderer+electron
npm run test        # ~750 tests, no network
npm run verify      # ten sections: the gate below, plus the docs and git checks
```

`npm run verify:record` also writes the run into `.ana/` under a neutral name, so the
claim "verify passed" has a receipt instead of a memory.

`ana` is this package's `bin`; `npm install` does not put it on PATH. Use
`node dist/cli.js` (after `npm run build`) or `npm link` once.

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

## Where the reasoning lives

- `docs/superpowers/PROGRESS.md` — what was built and why, in order.
- `docs/superpowers/EVIDENCE.md` — what each claim rests on.
- `docs/architecture.md` — the data flow from `survey` to `synthesize` to a report.
- `docs/desktop.md` — the window, what it deliberately does not do, and why.
- `docs/decisions/` — the choices that had alternatives.

## Known limits, stated rather than hidden

- The window does not run the slow acquisition. That belongs to the CLI; the window
  reads what is already on disk, which is why every click in it is instant.
- No packaged `.dmg`. `npm run build:bundle` produces a local `out/anatomy.app`.
- Candidate recall is 61% — the ceiling for this approach, measured, not estimated.
