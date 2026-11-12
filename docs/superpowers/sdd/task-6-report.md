# Task 6 report — structure: TypeScript/JavaScript (+ profile carry-over fix)

Status: DONE. `npm test` green (155 tests, 7 files, pristine output), `npm run typecheck`
clean. Commit `61f7733 feat(kernel): build TS/JS module graph and symbol index` on `mvp`
(parent `ceddfca`). Working tree clean apart from this report.

## What was built

### `src/kernel/structure/ts.ts` (new, 301 lines)

- `indexTypeScript(root: string, scope: Scope): Promise<StructureIndex>` — the only
  export. Parses with `ts.createSourceFile(file.path, text, ts.ScriptTarget.ES2022, true)`:
  no Program, no type checker, nothing project-wide. Language default-imported
  (`import ts from 'typescript'`, resolves under nodenext's implied `esModuleInterop`).
- Only keeps files whose `detectLanguage` is one of `ts|tsx|js|jsx|mjs|cjs`; `.d.ts` files
  are skipped (they declare someone else's implementation; there is nothing to quote).
- **Module graph.** One `ImportEdge` per distinct specifier per file, from
  `ImportDeclaration`, `ExportDeclaration` with a `from`, and
  `ImportEqualsDeclaration` + `ExternalModuleReference` (`import x = require('y')`).
  Dynamic `import()` / `require()` calls inside bodies are deliberately not chased.
- **Resolution** (hand-rolled, against the *scope's kept path set*, not the filesystem, so
  an edge can only point at something the reader can be shown):
  1. relative only: `.`, `..`, `./x`, `../x`; absolute and package specifiers keep
     `resolved: null` and do **not** increment `unresolved`;
  2. `path.posix.normalize(dirname(from) + specifier)`, query/hash and trailing `/`
     stripped; a base that escapes the root (`..`, `../…`) resolves to `null`;
  3. probe order `exact`, ESM twin (`.js`/`.jsx` → `.ts`, `.tsx`, `.d.ts`), then
     `.ts .tsx .js .jsx .mjs .cjs .d.ts`, then `<dir>/index<ext>` for each;
  4. a relative specifier that resolves to nothing increments `unresolved` once.
- **Symbols.** Every top-level declaration: functions, classes, interfaces, type aliases,
  enums (kind `type` — the contract has no `enum`), and `const`/`let`/`var` **with an
  initializer** (destructured binding names expanded, each a separate `const` symbol).
  `let`/`var` are reported as `const` because `SymbolKind` has no mutability axis.
  Namespace bodies (`namespace` / `declare namespace`) contribute their members, including
  members with no initializer only when they are declarations rather than value bindings.
  No nested function bodies, no class members. `line` is the 1-based line of the declared
  name (`node.name.getStart`), so a reader lands on `helper`, not on `export`.
- **Tolerance.** Unreadable file → `could not read <path>: <reason>` note and the file is
  skipped; a syntax error still yields the recovered imports and symbols, and one note
  `parse errors in <n> files` is appended at the end (count read from
  `sourceFile.parseDiagnostics`, which is not in the public typings but is the parser's own
  list — a Program, the alternative, is exactly what this module refuses to build).
- `modules` sorted by path, `symbols` by path, line, name, so a merge of several passes is
  deterministic.

### `src/kernel/structure/index.ts` (new, 50 lines)

- Re-exports `indexTypeScript`.
- `mergeIndexes(indexes: StructureIndex[]): StructureIndex` — concatenates modules and
  symbols with module identity = `path` and symbol identity = `path:name` (first wins),
  sums `unresolved` unconditionally (it is a measurement, not an identity) and
  concatenates `notes` in first-seen order without duplicates.

### Carry-over fix in `src/kernel/profile.ts` (Task 5 review)

- `NON_CODE_EXTENSIONS` gained `rst`, `ini`, `cfg`, `env`, `sum`, `pyi`, so a repo whose
  only "unreadable" files are `go.sum`, `.env`, `docs/index.rst`, `setup.cfg` or
  `pkg/types.pyi` no longer emits a false `unanalysed language: other` caveat.
- The catch-all bucket now names its dominant extension: `unanalysed language: other (vue)
  (50%)`. Extension counts are kept per-extension inside the bucket, most frequent wins,
  ties break alphabetically so one tree always reports the same extension.

### `tests/structure-ts.test.ts` (new, 236 lines, 7 tests)

Fixture repo (temp dir + `selectScope`, as the kernel does) contains: `src/a.ts` →
`./b` (`src/b.ts`), `./c.js` with only `src/c.ts` (ESM twin), `zod` and `node:fs`
(packages), `/opt/absolute.js` (absolute), `./missing` (unresolvable), `./dir` →
`src/dir/index.ts` (directory index), `src/broken.ts` (real syntax error, import
recovered), `src/symbols.ts` (one declaration of every kind, destructured bindings, an
ambient namespace, a nested function inside a top-level function, a class member),
`README.md` and `src/ignored.py` (must not be indexed). Plus `mergeIndexes` dedupe/sum/note
tests and an empty-scope test.

## RED / GREEN

1. RED: `npx vitest run tests/structure-ts.test.ts` →
   `Failed to load url ../src/kernel/structure/index.js … Does the file exist?` (0 tests).
2. GREEN after writing `ts.ts` + `index.ts` → 7/7 passed, no implementation change needed.
3. RED for the carry-over: three profile tests failed —
   `expected [ 'unanalysed language: other (50%)' ] to deeply equal [ … 'other (vue) (50%)' ]`,
   the new most-frequent-extension test, and
   `expected [ 'unanalysed language: other (55%)' ] to deeply equal []` for the furniture
   fixture. GREEN after the `profile.ts` edit.
4. `npm test`: 7 files, 155 tests, all pass, pristine output. `npm run typecheck`:
   clean (`tsc --noEmit` + `tsc -p tsconfig.test.json`).

## Files

- `src/kernel/structure/ts.ts` — new; module graph, resolution, symbol extraction.
- `src/kernel/structure/index.ts` — new; `mergeIndexes` + re-export.
- `tests/structure-ts.test.ts` — new; 7 tests.
- `src/kernel/profile.ts` — deny-list extended, `other (<ext>)` labelling.
- `tests/profile.test.ts` — updated expectation + 2 new tests (extension naming,
  repo furniture is silent).
- Untouched as required: `src/cli.ts`, `src/contracts/types.ts`, `src/kernel/acquire.ts`,
  `src/kernel/canonicalize.ts`. `StructureIndex.notes` already existed; no type change.

## Self-review

- Precision choices are all one-directional and documented in the file: only relative
  specifiers can be "unresolved", an edge never points outside the scope, duplicate
  specifiers collapse to one edge, and the kind mapping (`enum` → `type`,
  `let`/`var` → `const`) is stated rather than guessed at by consumers.
- Probe order matches the brief literally, with the ESM twin inserted immediately after
  `exact` because `b.js.ts` names nothing while `b.ts` is what `./b.js` means in every
  ESM-TypeScript project.
- Line numbers are the declared name's line, which is what the later evidence slicer needs;
  a symbol without a simple name (anonymous `export default`) is dropped rather than
  invented as `default`.
- No new dependency: `typescript` was already a devDependency. No filesystem probing for
  resolution means tests do not need real directories for targets.
- Sorting both arrays makes `mergeIndexes` output stable for a given input order.

## Concerns

1. **Resolution targets include non-module files.** `kept` is the whole scope, so
   `import './styles.css'` resolves to `src/styles.css`, and `import './types'` resolves to
   a `src/types.d.ts` that is deliberately not indexed. Verified on a scratch tree: two
   `resolved` edges pointing at paths with no `ModuleNode`. One-line fix when it matters:
   build the resolution set from the parsed files only
   (`PARSED_LANGUAGES.has(detectLanguage(path))` and not `DECLARATION_FILE`), which would
   turn both into `unresolved` instead. Not changed here because it alters
   `unresolved` semantics (a CSS import would then count as broken).
2. **`declare module 'pkg' { … }` augmentation blocks** are walked like namespaces, so
   their members are attributed to this file. The line numbers are real, but the names
   belong to someone else's API. Worth a guard if a later stage starts scoring symbols.
3. **Symbol identity is `path:name`.** Overloaded function signatures at top level produce
   two symbols with the same key, which `mergeIndexes` then collapses within a pass; a
   single index keeps both. Harmless for now, visible if symbol counts become a signal.
4. `unresolved` counts specifier occurrences, not distinct specifiers per file across
   files, and does not distinguish "no such file" from "outside the scope". The brief
   treats it as a single tally, so this stays.

## Fix round 1

Follow-up commit `e1ed7ed` — `fix(kernel): tighten ts resolution and profiler deny-list`.
TDD: tests added first, RED recorded, then the source fixed (GREEN). No new dependencies,
no refactors outside the five items.

### 1 [Important] Profiler deny-list missed dotfile configs and snapshots

`src/kernel/profile.ts`
- `extensionKey` now returns `''` for `dot <= 0`, i.e. a leading dot is a *name*, not an
  extension. This subsumes `.gitignore`, `.env`, `.eslintrc`, `.npmrc`, `.prettierrc`,
  `.nvmrc`, `.gitattributes`, `.dockerignore` and anything else a tool ships, so
  `env`, `gitignore` and `editorconfig` were removed from `NON_CODE_EXTENSIONS`.
- `NON_CODE_EXTENSIONS` gained `snap`, `csv`, `xml`, `ipynb`, `map`, `log` for the
  non-dotfile data files that were being reported as `other (<ext>)`.

Covering tests (`tests/profile.test.ts`, `does not report dotfile config or snapshot files
as an unreadable language`):
- six dotfiles (`.eslintrc`, `.npmrc`, `.prettierrc`, `.nvmrc`, `.gitattributes`,
  `.dockerignore`) beside one `src/a.ts` → `notes === []` (was
  `unanalysed language: other (dockerignore) (86%)`).
- 20 `*.snap` beside 100 `.ts` → `notes === []` (was `other (snap) (17%)`).

### 2 [Important] `resolved` pointed at files that never become modules

`src/kernel/structure/ts.ts`
- Resolution moved out of the per-file loop: every edge is resolved after all modules are
  built, against `emitted = new Set(modules.map(m => m.path))` (the paths that actually got
  a `ModuleNode`, which also excludes unreadable files, not just the language filter).
- A specifier that hits a kept file outside `emitted` (`./styles.css`, `./config.json`,
  `./types` → `.d.ts`) yields `resolved: null` and does **not** increment `unresolved`, so
  the tally keeps meaning "a relative specifier we could not find".

Covering test (`resolves only to paths that become modules`): `.css`, `.json` and `.d.ts`
targets each give `resolved: null`; `index.modules` is only `['src/a.ts']`; `unresolved`
is `1`, counting only the deliberately missing `./missing`.

### 3 [Minor] Dotted namespace bodies were dropped

`src/kernel/structure/ts.ts` — a `ModuleDeclaration` body is now recursed into when it is
either a `ModuleBlock` or another `ModuleDeclaration`. Covering test
(`collects the members of a dotted namespace`): `namespace A.B { export const q = 1 }` →
`q:const:2` (was `[]`).

### 4 [Minor] `.jsx` specifiers probed the wrong twin first

`src/kernel/structure/ts.ts` — the ESM twin order now follows the specifier kind:
`.jsx` probes `stem.tsx`, `stem.ts`, `stem.d.ts`; `.js` keeps `stem.ts`, `stem.tsx`,
`stem.d.ts`. Covering test (`probes the .tsx twin first for a .jsx specifier`): with both
`src/c.ts` and `src/c.tsx` present, `./c.jsx` resolves to `src/c.tsx` (was `src/c.ts`).

### 5 [Minor] Untested branches closed

`tests/structure-ts.test.ts`
- `.d.ts` never becomes a `ModuleNode` and is still a resolution target yielding
  `resolved: null` — covered by `resolves only to paths that become modules` (asserts the
  module list and `./types`).
- `import y = require('./y')` and `export * from './z'` as edge sources — new test
  `takes import=require and export-from as edge sources`, asserting the full import arrays
  and `unresolved === 0`.
- `mergeIndexes([])` — new test `merges nothing into an empty index`, expecting
  `{ modules: [], symbols: [], unresolved: 0, notes: [] }`.

### RED / GREEN

RED (tests only, before the fix): `npx vitest run tests/structure-ts.test.ts tests/profile.test.ts`
→ `Tests 4 failed | 31 passed (35)`; failures were the dotfile/snapshot note test, the
non-module resolution test, the `.jsx` twin test and the dotted namespace test. The item 5
tests passed immediately (branch coverage, no behaviour change) — noted, not adjusted to
fail artificially.

GREEN: same command → `Tests 35 passed (35)`.

### Commands and output

- `npm test` → `Test Files 7 passed (7)`, `Tests 161 passed (161)` (was 155).
- `npm run typecheck` → `tsc --noEmit && tsc -p tsconfig.test.json`, clean, no output.
- `git commit` → `e1ed7ed fix(kernel): tighten ts resolution and profiler deny-list`.
