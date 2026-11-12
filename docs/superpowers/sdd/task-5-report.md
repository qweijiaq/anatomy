# Task 5 report — repository profile (+ acquire hash carry-over)

Status: DONE. `npm test` green (139 tests, 6 files, pristine output), `npm run typecheck`
clean. Commit `13bdb5b feat(kernel): profile repository shape` on `mvp` (parent `00448f6`).

## What was built

### `src/kernel/profile.ts` (new, ~460 lines)

- `profileRepo(root: string, scope: Scope): Promise<Profile>` — the only export. `scope`
  defines membership ("inside the analysed scope" = `scope.files` contains the path);
  `root` is read only for manifest bytes, which the scope does not carry.
- `manifests`: exact filenames `Cargo.toml`, `go.mod`, `package.json`, `pyproject.toml`,
  `setup.py`, searched at the root and in each immediate subdirectory, returned
  repo-relative and sorted. Depth is capped at one level by design. Skipped: symlinked
  directories, dot-directories (`.github`, `.config`), and `build` / `dist` /
  `node_modules` / `target` / `third_party` / `vendor` — the same structural exclusion
  `selectScope` applies, so a manifest inside an installed dependency cannot pretend to
  be the project root.
- `entryPoints`, assembled in the order the report presents them and de-duplicated with
  first position kept:
  1. `package.json` `bin` (string, or object values in sorted key order) then `main`, for
     every detected `package.json` (nested ones are prefixed with their directory);
     `./` stripped, absolute paths and `..` rejected.
  2. `pyproject.toml` that declares at least one key in `[project.scripts]` or
     `[tool.poetry.scripts]` — the manifest path itself is recorded (see Concerns).
  3. `src/index.{ts,tsx,js,jsx,mjs,cjs,py}`.
  4. `__main__.py` at the root or in one package directory.
  5. files directly in the root `bin/` directory.
  A candidate is only recorded when it is a kept scope file: `bin: ./dist/cli.js` names a
  file the report will never quote, and a `main` that does not exist names nothing.
- `hasTests` from `**/*.test.*`, `**/*_test.*`, `**/test_*.py`, a kept path under any
  `tests/`, or a `tests/` directory on disk (so an emptied-but-present dir still counts).
- `hasCi` from a kept path under `.github/workflows/`, that directory itself, or a root
  `.gitlab-ci.yml` / `azure-pipelines.yml` / `circle.yml`.
- `hasDocs` from a kept `README.md` / `README.rst` (case-insensitive), a kept `docs/` path,
  or a `docs/` directory.
- `languages` is a copy of `scope.byLanguage` (no re-derivation, no drift).
- `notes`, appended and never thrown:
  - `no analysable files found` when the scope is empty;
  - `unanalysed language: <name> (<pct>%)` for every language with >= 5% of kept files
    that `detectLanguage` returns `null` for, sorted by share descending then by name;
  - `could not parse <path>: <reason>` for each manifest that cannot be read or parsed
    (malformed JSON, non-object top-level JSON, unreadable file, malformed TOML shape).

### Tolerant parsing

- `package.json`: read through `canonicalizeFile` (BOM / latin-1 / CRLF handling for free),
  then `JSON.parse` inside `try`. Every failure becomes a note, never an exception; the
  file still appears in `manifests`, because "there is a manifest here I could not read"
  is a fact the report needs.
- `pyproject.toml`: no TOML dependency. A structure scan tracks bracket/brace depth and
  quote state (`"`, `'`, `"""`, `'''`) so multi-line arrays, inline tables, triple-quoted
  strings and trailing `#` comments are skipped correctly, and only classifies lines that
  begin at depth 0. It throws (→ note) only on shapes that are unambiguously invalid: a
  table header without its closing bracket, an unterminated single-line string, or a
  depth-0 line that is neither `key = value` nor `[table]`. The limits are stated in a
  doc comment: values are never interpreted, so `"widget.cli:main"` is not resolved to a
  file; anything subtler than the three cases above passes silently, which loses a caveat
  rather than inventing a false one.
- Nothing in the repository is executed: `setup.py` is never imported, npm lifecycle
  scripts are never run. A test asserts that a `postinstall` script and a `setup.py` that
  would both write `PWNED` leave no file behind.

### Carry-over fix in `src/kernel/acquire.ts`

`hashTree` now skips `.git`, `build`, `dist`, `node_modules` and `vendor` (name-based at
any depth, matching `selectScope`'s `DIRECTORY_REASONS`). Before this, `git status` /
`git commit` rewrote `.git/index` and changed the local `sha`, hence the derived `runId`,
for a byte-identical analysed tree — reproducibility defeated by ordinary git activity.
Symlinks are still not followed; everything else about the digest is unchanged.

## RED / GREEN

1. RED — `tests/profile.test.ts` written first: `Failed to load url ../src/kernel/profile.js
   ... Does the file exist?` (module absent). First version of the file also carried the
   import of `selectScope`, so the failure was purely the missing module.
2. RED — new acquire test `ignores .git and build output, so ordinary git activity keeps
   the sha`: `expected '76d2fe82...' to be '7a64f54c...'`, i.e. an unchanged source tree
   changed its sha after `.git/index` and friends were created.
3. GREEN — `src/kernel/profile.ts` implemented, `HASH_IGNORED_DIRS` added to `hashTree`;
   14 profile tests + 52 acquire tests pass.
4. One iteration was needed on types: `let entries` in `findManifests` was implicitly
   `any[]` under `strict`/`noUncheckedIndexedAccess`; it broke `tsc` and therefore also
   `tests/cli.test.ts`, which compiles the tree before exercising `dist/cli.js`. Fixed by
   annotating `Dirent[]`.

Final: `npm test` → 6 files, 139 tests passed, no skips, no warnings; `npm run typecheck`
→ clean.

## Files

- New `src/kernel/profile.ts` — `profileRepo` + manifest scan, tolerant package.json /
  pyproject readers, entry-point resolution, flags, notes.
- New `tests/profile.test.ts` (263 lines, 14 tests) — fixture repo built into a temp dir
  with `package.json` (`bin` + `main` + a `postinstall` script), `pyproject.toml`, a
  `tests/` dir, `.github/workflows/ci.yml`, `README.md`, `bin/ana.js`, `crates/core.rs`
  (unanalysed language), `crates/Cargo.toml` (one level down) and
  `crates/inner/go.mod` (two levels down, must not appear). Plus: empty repo, malformed
  package.json, malformed pyproject.toml, decorative-but-valid multi-line TOML, `bin`
  string vs. out-of-scope `bin`/`main`, 5% threshold both sides, multi-language ordering,
  test-file detection by name, `__main__.py` + `bin/`, manifests inside
  vendor/dist/node_modules, and no-execution.
- Modified `src/kernel/acquire.ts` — `HASH_IGNORED_DIRS` + one `continue` in the walk,
  documented in the `hashTree` doc comment.
- Modified `tests/acquire.test.ts` — one new test covering the churn-vs-edit distinction.
- Not touched: `src/cli.ts`, `src/contracts/types.ts`. No type was missing: `Profile`
  already carries exactly `languages`, `manifests`, `entryPoints`, `hasTests`, `hasCi`,
  `hasDocs`, `notes`.

## Self-review

- Notes are append-only and never thrown, in all four paths (empty scope, unsupported
  language, unreadable manifest, unparsable manifest). A malformed `package.json` still
  shows up in `manifests`, so the report says "we saw a package.json" and "we could not
  read it" instead of silently having no manifest.
- Determinism: every list is sorted (`manifests`, bin object keys, `__main__`/`bin` entries
  from a sorted kept-path list) and the one order-sensitive list (`entryPoints`) follows a
  fixed precedence. A `toEqual` test calls the profiler twice.
- Ties in the language note sort are broken by name, so two equally-sized unsupported
  languages always print in the same order.
- `notes` percentage is the share of *kept* files, not of bytes: the reader wants to know
  how much of what was read is unreadable, not how heavy it was.
- The `bin/` directory rule is name-based, not mode-based (an executable bit check would
  be meaningless in an extracted tarball on some platforms), and only one level deep.

## Concerns

1. `entryPoints` records `pyproject.toml` itself when `[project.scripts]` /
   `[tool.poetry.scripts]` is non-empty, because the brief says resolving script *values*
   is out of scope and "just record the manifest path". Semantically that puts a TOML file
   in a list of code entry points; if the report header should not show it, the two-line
   branch in `profileRepo` (`else if (base === 'pyproject.toml')`) can simply be deleted.
2. "Unanalysed language" is restricted to a curated set of programming-language
   extensions (rust, go, c, c++, c#, java, kotlin, ruby, php, swift, scala, elixir,
   erlang, haskell, ocaml, elm, lua, perl, r, julia, dart, zig, nim, fortran, groovy,
   shell). Markdown / JSON / TOML / CSS-heavy trees therefore produce no language note. A
   literal reading of the rule (any extension `detectLanguage` returns `null` for) would
   emit e.g. `unanalysed language: md (24%)` in nearly every repository, which buries the
   caveat that matters. The extension table is one `Map` in `profile.ts`; widen or narrow
   it there.
3. Percentage is rounded for display (`Math.round`) while the 5% floor uses the exact
   share, so a 4.6% language produces nothing and a 5.0% one prints `5%`.
4. `hashTree` now ignores `vendor`/`dist`/`build`/`node_modules` by *name at any depth*.
   Two trees that differ only inside `src/vendor/` therefore hash identically. That matches
   what `selectScope` will analyse (it excludes the same names), so the digest tracks the
   analysed content rather than the checkout — but it does mean the sha is no longer a
   full-snapshot digest. If a future consumer wants a full snapshot, it needs a second
   hash rather than a different one.
5. `hasCi` / `hasDocs` fall back to a `stat` of the conventional directory, so a gitignored
   `.github/workflows/` still reports `hasCi: true`. Judged correct: the report describes
   the repository, and the flag only gates which evidence the model is told to look for.
6. `profileRepo` is not wired into `src/cli.ts` (out of scope for this task), so nothing
   produces a report header yet.

## Fix round 1 (committed by controller)

The implementer subagent stopped while adjusting two tests (42 tool calls). The tree it left already had `npm test` at 146 passed and `npm run typecheck` clean, so the controller committed it unchanged. Each of the nine items is verified by the re-review against the diff, not by this note.

Verified before commit: `npm test` 146 passed / 6 files, `npm run typecheck` clean.
