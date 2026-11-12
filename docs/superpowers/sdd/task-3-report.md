# Task 3 report — analysis scope (file selection)

Status: DONE. `src/kernel/scope.ts` implemented, fixture repository committed, `npm test`
green with pristine output, `npm run typecheck` clean. Commit subject
`feat(kernel): select files by analysis scope`.

## What was built

`src/kernel/scope.ts` (new, ~470 lines) exports:

- `selectScope(root, opts?): Promise<Scope>` — single-pass walk that excludes first, then
  counts, and throws as soon as a limit is crossed.
- `class ScopeLimitError extends Error` with `dimension: 'bytes' | 'files' | 'lines'`,
  `actual`, `limit`. Message: `anatomy: analysis scope exceeds the <dim> limit (a > b)`.
- `detectLanguage(path): string | null` — only `ts,tsx,js,jsx,mjs,cjs,py`; last extension
  only; extension lowercased (`a.TS` -> `ts`); `a.d.ts` -> `ts`; `a.ts.bak`, `Makefile`,
  `.gitignore`, `a.java` -> `null`.

### Exclusion pipeline and precedence

Directory-level (checked while descending, never entered):

| name | reason |
| --- | --- |
| `vendor`, `third_party`, `node_modules`, `.git` | `vendored` |
| `dist`, `build` | `generated` |

File-level, in this order (first match wins, each file counted once):

1. `gitignore` (this directory's rules + inherited rules + `extraIgnore`)
2. `vendored` / `generated` — only reachable via the directory table above
3. `minified` — basename matches `/\.min\.[^/]+$/`
4. `lockfile` — exact basenames `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`
5. `binary` — `0x00` byte inside the first 8 KB (only 8 KB is read, then early return)
6. `large-fixture` — size > 1 MiB AND the path has a `fixture/` or `fixtures/` segment

This order is literally the `REASON_ORDER` constant; it is also the order in which
`Scope.excluded` is emitted, and zero-count reasons are dropped. `dist/bundle.min.js`
therefore counts once as `generated`, never as `minified` (asserted in a test).

### Limits fail fast

Per candidate file, before anything expensive happens:

- `totals.files + 1 > maxFiles` -> throw (checked before the line scan)
- `totals.bytes + size > maxBytes` -> throw after `stat`, before the line scan
- `totals.lines + lines > maxLines` -> throw after the (already streamed) line count

So a limit breach costs one `stat` at most, never a full traversal or a full read. All
three counters are post-exclusion numbers (asserted: `extraIgnore: ['src','tests']` with
`maxFiles: 3` succeeds on a 19-file repository).

### Line counting

`countLines()` streams the file in chunks and counts terminators: `\n`, and lone `\r`
(so CR-only files match the canonicalizer). A trailing terminator adds no line; an empty
file has 0 lines. A test cross-checks every kept file against
`canonicalizeFile(...).lineCount` and `statSync(...).size`, so scope line numbers and byte
sizes agree with the module downstream evidence line numbers are anchored to.

### `subpath` and `extraIgnore`

- `subpath` is resolved against `root`; the walk starts there but reported paths stay
  root-relative (`subpath: 'src/nested'` -> `src/nested/deep.py`).
- Missing, non-directory, or root-escaping (`../escape`) subpaths throw an error whose
  message contains `subpath` (tested for all three).
- `.gitignore` files from `root` down to the start directory are still loaded, each
  resolved against its own directory, so a nested anchored pattern keeps working when the
  walk starts inside it.
- `extraIgnore` patterns compile as root-level gitignore rules and are appended **after**
  the root `.gitignore`, so an explicit user exclusion beats a `.gitignore` negation.
  They are reported as reason `gitignore`.

## RED / GREEN evidence

RED (implementation file temporarily removed so the suite ran against the tests only):

```
FAIL  tests/scope.test.ts [ tests/scope.test.ts ]
Error: Failed to load url ../src/kernel/scope.js (resolved id: ../src/kernel/scope.js)
 Test Files  1 failed (1)
      Tests  no tests
```

Second RED pass, with the implementation present but three of my own expectations wrong —
this is the useful one, it is what caught the ordering bug:

```
× counts each excluded file exactly once, under the first matching reason
  → expected 9 to be 7        (I had miscounted the fixture: 19 on-disk = 10 kept + 9 excluded)
× records the real byte and line sizes of kept files
  → expected 5 to be 4        (src/index.ts really has 5 lines)
× applies extraIgnore patterns as if they were gitignore rules at the root
  → important.log was still kept: root `.gitignore` has `!important.log`, which won
    because extraIgnore rules were prepended. Fixed by appending extraIgnore last.
```

GREEN:

```
 ✓ tests/canonicalize.test.ts (22 tests)
 ✓ tests/scope.test.ts (28 tests)
 ✓ tests/cli.test.ts (9 tests)
 Test Files  3 passed (3)
      Tests  59 passed (59)
```

`npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.test.json`) exits 0 with no output.

## Files

- `src/kernel/scope.ts` — new: `selectScope`, `ScopeLimitError`, `detectLanguage`, the
  gitignore matcher, streamed line counting, exclusion tables.
- `tests/scope.test.ts` — new: 28 tests (language map, fixture-repository expectations,
  limits, subpath/extraIgnore, gitignore pattern semantics).
- `tests/fixtures/repo-small/**` — new fixture repository, 19 files, includes `.gitignore`
  with `coverage/`, `*.log`, `!important.log`, `src/ignored-by-git.ts`;
  `src/nested/.gitignore` with an anchored `/scratch.ts` plus a sibling `src/scratch.ts`
  that must survive; `src/{index,util,component}.ts(x)`, `src/nested/deep.py`;
  `dist/bundle.min.js`; `vendor/lib.js`; `node_modules/pkg/index.js`; `package-lock.json`;
  `assets/logo.bin` (NUL in the first 8 KB); `tests/fixtures/big.bin` (1.1 MiB of text);
  `debug.log`; `important.log`; `README.md`; `tests/greet.test.ts`.
- `vitest.config.ts` — one added line: `exclude: [...configDefaults.exclude, 'tests/fixtures/**']`.
  Without it vitest collected `tests/fixtures/repo-small/tests/greet.test.ts` as a real
  test file (a fixture repository legitimately contains `*.test.ts`). This was the only
  non-test/impl edit; the config change is additive.
- `.gitignore` (repo root) — two negation lines plus a comment, see "Concerns".

## Self-review

- Did not touch `src/cli.ts`, `src/kernel/canonicalize.ts`, `src/contracts/types.ts`. No
  types were missing; `ScopeLimitDimension` was added locally in `scope.ts` because the
  contract file declares the error class nowhere.
- No new dependencies. `ignore` is not installed and `npm install` was off-limits, so the
  matcher is hand-written (see concerns).
- `Scope.excluded` is deterministic (fixed reason order) and drops zero counts, so the
  report header never prints "0 minified".
- Symlinks are skipped entirely (not followed, not counted) — they can leave the
  repository or loop, and no `ScopeExclusionReason` covers them.
- Files that vanish or cannot be stat/read between `readdir` and `stat` are skipped
  silently for the same reason (no reason code fits). This is the only place a real file
  can disappear without being counted; a loud alternative would need a new reason code.
- `.gitignore` itself and `src/nested/.gitignore` are *in* scope (language `null`). They
  are real project files; excluding them would be an opinionated extra rule.
- Empty files report `bytes: 0, lines: 0`, matching `canonicalizeText('')`.
- Directory entries are sorted for a deterministic `files` order and therefore a
  deterministic "fail fast" point.

## Concerns

### 1. The `.gitignore` matcher is a reimplementation, not the real thing

`ignore` was unavailable, so `globToRegex` + `isIgnored` cover the subset that real
repositories use: `*` (stops at `/`), `?`, `**` (leading `**/`, trailing `**`, embedded
`/**/`), leading-`/` and inner-slash anchoring, trailing-`/` directory-only patterns,
`!` negation with last-match-wins, `#` comments, leading `\#`/`\!` escapes, trailing-space
strip. Six tests pin the semantics through the public API (`extraIgnore`).

Known deviations, all deliberate:

- **Pruning beats negation.** An ignored directory is never entered, so `!` cannot
  re-include a file below it. Git behaves the same unless the parent directory is
  explicitly un-ignored first, so this matches git for every pattern that does not
  re-include a directory.
- **No early-exit dominance rule beyond "last match wins in the collected rule list".**
  Git's real evaluation can stop at a directory match; we rely on pruning instead. Same
  outcome as long as negations follow the pruning rule above.
- **Escaped spaces/backslashes mid-pattern and `[a-z]` character classes are not
  supported** — `[` is escaped literally. A repo using bracket classes would over-include,
  not silently drop (fail-safe direction).
- **`.git/info/exclude` and global excludes are ignored**; only `.gitignore` files are read.
- **`extraIgnore` wins over root `.gitignore` negations** (documented decision; the
  reverse is arguably more git-like, but "the user asked for this exclusion" seemed the
  stronger signal).

If any of this makes a reviewer uneasy, the honest next step is to install `ignore`
(pure JS, no native deps) and delete `globToRegex`/`isIgnored`; `selectScope` already
collects rules per directory with a base path, so it would be a localized swap.

### 2. `.git` is reported as `vendored`

The contract has no VCS reason. `.git` sits with `vendor`/`third_party`/`node_modules`
because it is third-party-managed data rather than project source. If the header text
matters, either accept it or add a `metadata` reason to `ScopeExclusionReason`
(contract change, not made here).

### 3. Fixture files that must be force-added

The fixture's own `.gitignore` (and `src/nested/.gitignore`) matches real fixture files
(`debug.log`, `src/ignored-by-git.ts`, `src/nested/scratch.ts`). Because git gives nested
ignore files precedence over top-level ones, negations in the repo-root `.gitignore`
cannot re-include them, so they were committed with `git add -f`. Once tracked they are
immune to ignore rules, so `git status` stays clean. The root `.gitignore` did gain two
negations (`!tests/fixtures/repo-small/dist/`, `!tests/fixtures/repo-small/node_modules/`)
because those two are excluded by the *root* rules and a later negation in the same file
does work there. Anyone regenerating the fixture must repeat the `-f` adds.

### 4. `tests/fixtures/repo-small/tests/fixtures/big.bin` is 1.1 MiB

Required by the brief (`large-fixture` needs a >1 MB file under a `fixtures/` segment).
It is repetitive text, so it compresses to almost nothing in the pack.

## Fix round 1

Follow-up on six review findings against `bc3b654`. Each was fixed test-first (items
1-4); items 5 and 6 are documentation/rename only. Commit
`02f2335 fix(kernel): anchor gitignore patterns and validate scope root`.

### 1 [Critical] Leading-slash patterns matched at any depth

`compileRule` computed `anchored = pattern.includes('/')` *after* stripping leading
slashes, so `/lib` compiled to the unanchored `(?:^|/)lib$` and pruned `src/lib/`.
Anchoring is now decided before the strip, exactly like git:

```ts
const anchored = pattern.startsWith('/') || pattern.includes('/')
pattern = pattern.replace(/^\/+/, '')
```

`dirOnly` handling is untouched. Redirect verification: root `.gitignore` gained
`/scratch.ts`, the fixture gained a root-level `scratch.ts` (force-added, its own
ignore rule matches it) and `src/nested/deeper/scratch.ts`. The existing test that
"claimed to pin this" (`tests/scope.test.ts`, "honours .gitignore patterns of each
directory") now asserts the full trichotomy:

```ts
expect(kept).not.toContain('scratch.ts')                    // root, anchored match
expect(kept).toContain('src/scratch.ts')                    // deep, must survive
expect(kept).toContain('src/nested/deeper/scratch.ts')      // deeper, must survive
expect(kept).not.toContain('src/nested/scratch.ts')         // nested `.gitignore` `/scratch.ts`
```

plus one new white-box-free case in "gitignore pattern semantics"
("anchors a leading slash at the base directory, like an inner slash": `/src/*.ts`
behaves like `src/*.ts`).

RED -> GREEN:

```
× honours .gitignore patterns of each directory, relative to that directory
  → expected [ '.gitignore', 'README.md', …(9) ] to include 'src/scratch.ts'
× keeps the project sources and buckets them by language
  → expected [ …(9) ] to strictly equal [ …(11) ]
...after the fix...
✓ tests/scope.test.ts (32 tests)
```

### 2 [Important] A bad `root` reported an empty scope

`selectScope` now stats the resolved root before anything else and throws a message
that carries the path:

```
anatomy: root "<abs>" does not exist          (stat failed)
anatomy: root "<abs>" is not a directory      (root is a file)
```

`walk` no longer swallows every `readdir` failure; only `ENOENT` (a directory that
vanished between listing and reading) is treated as "gone", everything else
(`EACCES`, `EMFILE`, ...) is rethrown, so an unreadable subtree cannot disappear
uncounted.

Covering tests (both failed before: `promise resolved { files: [], excluded: [] }
instead of rejecting`):

- `fails loudly on a root that does not exist` - message contains `anatomy: root` and
  the missing path.
- `fails loudly when the root is a file, not a directory` - `README.md` as root,
  message matches `/not a directory/` and `/README\.md/`.

### 3 [Important] Limit tests could not distinguish fail-fast from traverse-then-check

All three limit cases are rewritten to breach partway through the walk and to assert
the *reported progress* (`ScopeLimitError.actual`), which is the only public observable
of how far the walk got:

- files: `maxFiles: 6` on a 13-kept-file fixture, expects `{ dimension: 'files',
  limit: 6, actual: 7 }` and asserts `full.totals.files > 7` (i.e. a walk that finished
  first would have reported 14).
- bytes: limit = sum of the first 3 kept files' bytes + 1, breach on the 4th; expects
  `actual` = prefix + that file's size and asserts `full.totals.bytes` is larger.
- lines: limit = sum of the first 3 kept file's lines + 1, breach on the 4th; expects
  `actual` = prefix + that file's lines and asserts the file really has > 1 line and
  that `full.totals.lines` is larger.

RED was produced by mutating the implementation (temporary, then reverted) into
traverse-then-check: the three in-loop throws removed, checks moved after `walk()`:

```
FAIL  selectScope limits > fails fast on file count, partway through the walk
  → expected ScopeLimitError { dimension: 'files', actual: 13, limit: 6 } to match
    object { dimension: 'files', limit: 6, actual: 7 }
FAIL  selectScope limits > fails fast on bytes, partway through the walk
  → actual: full-tree bytes instead of the first-4-file prefix
FAIL  selectScope limits > fails fast on lines, partway through the walk
  → expected … { dimension: 'lines', limit: 12 } to match object { actual: 15 }
 Tests  3 failed | 29 skipped (32)
```

With the real (fail-fast) implementation the same tests pass, so the distinction is
now observable.

### 4 [Minor] `extraIgnore` was not actually last

`extraIgnore` patterns were appended to the root rule list, i.e. *before* nested
`.gitignore` rules, so a nested `!` negated a caller exclusion. Extras are now a
separate list threaded into `isIgnored(relPath, isDir, rules, extras)` and evaluated
after every `.gitignore` rule; a `matches(rule, relPath, isDir)` helper keeps both
loops identical. Directory pruning uses the same function, so extras still exclude
directories (existing `extraIgnore: ['src', 'tests']` test).

New fixture `tests/deeper/.gitignore` (`*.ts` + `!keep.ts`) with
`tests/deeper/keep.ts`. New test "evaluates extraIgnore after every .gitignore,
including nested negations": `keep.ts` is kept by default, and with
`extraIgnore: ['*.ts']` it is gone.

RED: `expected [ '.gitignore', 'README.md', …(6) ] to not include 'tests/deeper/keep.ts'`.

### 5 [Minor] Matcher limits documented in code

A docblock above `globToRegex` lists exactly what is not supported: `[...]` character
classes (escaped literally, so `[Bb]in/` never matches), `.git/info/exclude` and global
`core.excludesFile` excludes, re-inclusion below a pruned directory, and escaped
spaces/backslashes mid-pattern. It also states why the direction is safe: every gap
makes a pattern match *less* than git, so the file is kept (over-inclusion), and hiding
real source would be the failure mode this module exists to prevent. No character
class support was added.

### 6 [Minor] Shadowed `path` parameter

`detectLanguage(path: string)` -> `detectLanguage(filePath: string)`; the `node:path`
import is no longer shadowed. Body unchanged.

### Fixture delta

Root `.gitignore` + `/scratch.ts`; new files `scratch.ts` (root),
`src/nested/deeper/scratch.ts`, `tests/deeper/.gitignore`, `tests/deeper/keep.ts`.
The fixture is now 23 files: 13 kept + 10 excluded. Reported breakdown is unchanged in
shape: `gitignore` 4, `vendored` 2, `generated` 1, `lockfile` 1, `binary` 1,
`large-fixture` 1. Updated count assertions:
`reasonCount(scope, 'gitignore') === 4`, excluded sum `10`, `totals.files + 10 === 23`,
`byLanguage['ts'] === 6`). `scratch.ts` had to be `git add -f` (the fixture's own
ignore rule matches it, same situation as `debug.log` in the Task 3 note).

### Commands and output

```
$ npx vitest run tests/scope.test.ts        # extended tests, implementation unchanged
  Tests  8 failed | 24 passed (32)

$ npx vitest run tests/scope.test.ts        # after the fixes
  Test Files  1 passed (1)
       Tests  32 passed (32)

$ npm test
 ✓ tests/canonicalize.test.ts (22 tests)
 ✓ tests/scope.test.ts (32 tests)
 ✓ tests/cli.test.ts (9 tests)
 Test Files  3 passed (3)
      Tests  63 passed (63)

$ npm run typecheck                          # tsc --noEmit && tsc -p tsconfig.test.json
(no output, exit 0)
```

Both suites print no warnings, stderr lines, or unhandled-rejection noise.
