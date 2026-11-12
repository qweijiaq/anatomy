# Task 10 report — evidence validation and token budget

## Built

- `src/kernel/evidence.ts`
  - `validatePoints(points, root, runId)`: three-way outcome (dropped / downgraded / kept) with `stats.evidenceRate`, `stats.droppedEvidence`, `stats.avgEvidence`.
  - `evidenceId(runId, path, startLine)`: `runId` + first 6 hex of `sha256(path + "\0" + startLine)`.
  - `NO_VERIFIABLE_EVIDENCE`: the one string appended to `unknowns` (exported so later stages cannot drift from it).
  - Files are canonicalized through `canonicalizeFile`, cached by absolute path for the duration of one call. Absolute paths and paths whose `path.relative(root, abs)` escapes (`..`, or resolves to the root itself) are refused **before any read**.
- `src/kernel/budget.ts`
  - `estimateTokens({system, user})`, `fitCandidates(cands, ctxOf, limit)`.
- `src/kernel/pipeline.ts` (Task 9 carry-over) — run artifacts tracked as they land; `settleFailure` now marks the run `failed` unless every artifact of this scan was written by this scan, and `stampManifest` keeps the stage error as `cause` when its own write fails.
- `tests/evidence.test.ts` (31 tests), `tests/budget.test.ts` (9 tests), `tests/scan.test.ts` (2 carry-over tests; one replaced, one added).

## RED / GREEN

- RED: `mv src/kernel/{evidence,budget}.ts /tmp/` then `npx vitest run tests/evidence.test.ts tests/budget.test.ts` → `Test Files 2 failed (2)`, `Tests no tests` (module not found). Files restored.
- RED (carry-over): the pre-existing test `keeps an earlier complete run complete when a re-scan cannot finish` described the old behaviour and would fail against the new rule; it was replaced by `marks a re-scan failed when it overwrote only part of an earlier run`, plus a new `keeps an earlier complete run complete when a re-scan wrote nothing`.
- GREEN: `npm test` → 12 files, 315 tests passed, empty stderr. `npm run typecheck` → clean (`tsc --noEmit` + `tsc -p tsconfig.test.json`).

## Decisions and where I had to guess

### `tokenx` has no `estimateTokenCount`

The brief names `tokenx`'s `estimateTokenCount`. `tokenx@0.4.1` (installed) exports `approximateTokenSize`, `approximateMaxTokenSize`, `isWithinTokenLimit`, `getModelContextSize`, `resolveModelName` — no `estimateTokenCount` under any name. `estimateTokens` therefore calls `approximateTokenSize(system + user)` literal concatenation, which is the package's token estimator. Documented in the module header. If a different package/version was meant, this is the one line to change.

### wrong vs missing — the guesses

- **A point with several evidence items, one of them wrong**: the point is dropped, and `stats.droppedEvidence` counts *every* failing item (all evidence is still checked after the first failure, so the stat says how much was invented rather than just how many points died). A point whose evidence is *entirely* missing (empty array) is the "missing" case and is downgraded. A point with zero evidence and zero failures is never "wrong".
- **Any zero-evidence point is downgraded**, whatever its confidence — the brief's first clause ("`evidence` 为空") is confidence-independent; the second clause (`high` with nothing verifiable) is a subset of it. So `medium`/`low` with no evidence also become `low`, and one downgrade reason string covers both cases.
- **`null` evidence array** is treated as malformed (dropped), not as zero evidence (downgraded), because requirement 8 lists "null evidence arrays" under malformed input.
- **Shape check is shallow**: `id` (non-empty string), `theirs` (object) with `evidence` (array), `confidence` in `high|medium|low`. Everything else is passed through untouched. A missing `unknowns` is tolerated and normalized to `[]` on downgrade rather than costing a verifiable point. `title`/`kind`/`problem` are not checked: nothing in this module reads them.
- **`evidenceRate` numerator** excludes downgraded points: a point kept on zero evidence has nothing verified, so it counts as 0, not as vacuously 1. `avgEvidence` therefore counts the *verified* evidence of kept points. `avgEvidence` is rounded to 2 decimals; `evidenceRate` is left unrounded (the brief only asks for rounding on `avgEvidence`).
- **Evidence ids are rewritten, never trusted**: each verified evidence item gets `evidenceId(runId, relPath, startLine)`, replacing whatever the model wrote (`tests/evidence.test.ts` asserts the model's `model-supplied-id` is gone). Verified evidence paths are normalized to the repo-relative posix path, so `./a.ts` and `a.ts` produce one evidence item, not two.
- **Single-line snippets are matched against their own line** (`line.includes(snippet)`, so both whole-line and substring pass) and must report `startLine === endLine`. The global-first-occurrence rule was deliberately *not* applied here: a snippet repeated on lines 3 and 10, cited at line 10, is real evidence and must not be dropped.
- **Multi-line snippets use `lineRangeOfSnippet`**, i.e. the first occurrence's range must equal the reported range. This is the strict reading of "the snippet's own line range not equal to `[startLine, endLine]`" — see concerns.
- **Bounds are asserted explicitly** (`1 <= startLine <= endLine <= lineCount`) before any snippet work. `offsetOfLine`'s `RangeError` is never used as the check; `tests/evidence.test.ts` cites line 5 of a 4-line file and asserts the point is dropped.

### budget

- Sort: score descending (`Number.NaN`/`±Infinity` scores sort last, never throw), then `path`, then `line`, then input order. Greedy; a candidate that does not fit is skipped and the scan continues with cheaper ones, so `dropped` is the count of skipped candidates.
- A non-finite or non-positive `limit` keeps nothing. Fail-closed on purpose: a broken budget must not silently become an unlimited one.

### pipeline carry-over

- `RUN_ARTIFACTS = ['scope','profile','structure','candidates']`. `written` records a name only after `run.write` resolves. `settleFailure`:
  1. all four written → stamp `complete` (content is this run's; only bookkeeping failed);
  2. nothing written over an earlier `complete` run → restore the previous manifest and report the failure against it;
  3. otherwise → stamp `failed`.
- `stampManifest` catches its own write failure and returns an error whose `cause` is the stage error, with both messages visible, so the stage error is never masked.
- The mixed case surfaces the *stage* error (e.g. `EISDIR`) unchanged; the manifest is what carries the run's verdict. `tests/scan.test.ts` asserts the manifest, not the message.

## Concerns

1. **`tokenx` API name mismatch** (above). One-line change if the spec meant a different estimator.
2. **Multi-line duplicate code can be falsely dropped.** Because the range comes from the *first* occurrence, a two-line snippet that appears identically at lines 20-21 and 90-91, cited at 90, is dropped as "on lines 20..21, not 90..91". Fails closed, which is the right direction for this product, but it is a real false negative. A cheaper rule ("the snippet is a verbatim substring of lines `start..end` and starts at the first character of `startLine`") would fix it; I did not adopt it because binding decision 2 explicitly names the snippet's own line range as the test. Recorded for the next revisit.
3. **Symlinked escape is not caught.** Containment is lexical (`path.relative`); a path inside the root that is a symlink pointing outside would be read. Fixing it needs `realpath` on both the root and the candidate file. Out of scope here, worth a line in the security review.
4. **`settleFailure`'s write-failure path is untested.** `openRun` writes the manifest first, so blocking `manifest.json` fails the *open*, not the settle, and I found no deterministic way to make the settle-write fail after a successful open without adding a test seam. The `cause` attachment is implemented and reviewed, but only exercised by inspection.
5. **`1 <= startLine <= endLine <= lineCount` rejects a snippet that legitimately ends with a newline** (`"...\n"`): `lineRangeOfSnippet` puts its `endLine` on the previous line, so `[2,3]` is reported as wrong for a snippet covering lines 2-3 plus the trailing newline. Slices are handed to the model without trailing newlines, so this should not fire in practice.
6. **`estimateTokens` concatenates without a separator.** `{system: 'sys', user: 'tem'}` costs the same as `'system'`. Deliberate (the brief says "on the concatenation"), and pinned by a test, but it is a token-boundary artifact a reader may not expect.

## Fix round 1 (validator)

Branch `mvp`, base `c11074f`, commit `9d4a8a5 fix(kernel): tighten evidence classification`. Files touched: `src/kernel/evidence.ts`, `tests/evidence.test.ts`. No other file, no dependency, no refactor.

### RED / GREEN

- RED: new tests added first, `npx vitest run tests/evidence.test.ts` → `Tests 7 failed | 31 passed (38)`; the seven failures were exactly the six items below (seven tests: items 1, 2, 3, 4x2, 5, 6).
- GREEN: `npx vitest run tests/evidence.test.ts` → `38 passed`; `npm test` → `Test Files 12 passed (12)`, `Tests 322 passed (322)`; `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.test.json`) clean.

### 1 [Important] One character no longer certifies a point

- `evidence.ts`: added `isSubstantial()` with `MIN_SNIPPET_NON_WHITESPACE = 8` and `ALNUM_RUN = /[A-Za-z0-9]{3,}/`, checked before the file is read (so a thin snippet costs no I/O). Reason: `evidence <path>:<line> is too short to be evidence`.
- Whitespace-only snippets are still caught first by the existing `trim() === ''` check; an empty-string snippet is still rejected as before.
- Tests: `drops snippets too thin to certify a point` — `'n'` cited at line 3 (where a lone `n` really is), `'{'` cited at line 2 (where the brace really is), `'   '` at line 3. Each is dropped and each counts one `droppedEvidence`.
- Covering test adjusted: `accepts a part of a line as well as a whole line` used the snippet `'n * 2'` (3 non-whitespace characters, no 3+ alphanumeric run), which the new rule rejects by design. It now cites `'return n * 2'`, still only part of line 3, so the behaviour under test (a sub-line snippet is accepted) is unchanged.

### 2 [Important] Duplicated code is accepted wherever it is cited

- `evidence.ts`: `rangeOfCitedOccurrence()` walks every occurrence with `indexOf(snippet, from)`, accepts as soon as one occurrence's range equals `[startLine, endLine]`, and breaks once an occurrence's start line exceeds `endLine`. When none matches, the rejection still quotes the first occurrence's range (unchanged message shape, pinned by the existing `lines 2\.\.4` test). `'n * 2'`-style overlapping occurrences are reachable too because the scan advances by one character, not by the snippet length.
- Tests: new fixture `dup.ts` (same `return n * 2` + `}` block at 3-4 and 90-91); `accepts the second citation of duplicated code` cites both and asserts both ids survive (`[3, 90]`).

### 3 [Important] Verified evidence is deduplicated

- `evidence.ts`: `validatePoints` keeps a per-point `Set` of verified ids and skips repeats, so five copies of one snippet produce one `Evidence` and contribute one to `evidenceTotal`.
- Test: `counts one snippet repeated five times once` — five copies of `ev()` yield `theirs.evidence` length 1 and `{ evidenceRate: 1, droppedEvidence: 0, avgEvidence: 1 }`.

### 4 [Important] A snippet starting with a newline is no longer off by one

- Kept local to `src/kernel/evidence.ts`; `canonicalize.ts` untouched. The off-by-one came from `lineRangeOfSnippet` computing `startLine = countLines(text.slice(0, index)) + 1`, which counts a match that begins mid-line as starting on the next line. The new `lineOfIndex()` counts the newlines strictly before the match, and `rangeOfMatch()` applies the existing trailing-newline rule (`matched.endsWith('\n')` shrinks `endLine` by one). With correct line counting a leading newline needs no extra adjustment: the newline char is on the line it terminates, so `'\n  return 1'` is reported `[2, 3]`.
- Tests: fixture `newline.ts` (`l1` / `export function f() {` / `  return 1` / `}` / `l5`). `accepts the honest range of a snippet that starts with a newline` keeps `[2, 3]`; `drops the off-by-one range a leading newline would suggest` drops `[3, 4]` with a `lines 2\.\.3` reason.

### 5 [Minor] CRLF snippets are normalized

- `evidence.ts`: the incoming snippet is `rawSnippet.replace(/\r\n?/g, '\n')` before any comparison, and the normalized form is what is stored on the `Evidence`, so `Evidence.snippet` stays an exact substring of canonical text.
- Test: `accepts a snippet the model echoed back with CRLF` — lines 1-2 of `a.ts` quoted with `\r\n`; the point is kept and the stored snippet is the `\n` form.

### 6 [Minor] Confidence is matched case-insensitively

- `evidence.ts`: `checkShape` normalizes with `confidence.trim().toLowerCase()` before the `high|medium|low` check, and the kept point carries the normalized value (`'High'` does not survive into the report — `LearningPoint.confidence` is a `'high' | 'medium' | 'low'` union, so passing the raw spelling through would have been an unchecked leak).
- Test: `reads a confidence the model capitalized or padded` covers `'High'` and `' HIGH '`: neither is dropped, both are kept with `confidence: 'high'`.

### Concerns from this round

1. `canonicalize.ts`'s exported `lineRangeOfSnippet` is now unused by production code (`evidence.ts` no longer imports it) and still carries the mid-line-start off-by-one that item 4 describes. Fixing it means changing line maths inside `canonicalize.ts`, which was out of scope for this round; the only remaining caller is `tests/canonicalize.test.ts`, whose cases all start at column 0 and therefore cannot see the bug. Worth either fixing or deleting in the next pass.
2. Duplicate detection keys on `evidenceId`, i.e. `(path, startLine)`. Two genuinely different snippets on the same start line collapse into one item. Fail-closed for the trust numbers (they can only go down), but it is a small loss of real evidence.
3. The minimum length is a threshold: a real 5-character excerpt such as `n * 2` is now rejected. That is the requested rule and it fails closed, but it can reject honest terse citations of very short expressions.

## Fix round 1 (found by a real run, not by review)

Running `ana analyze` against a real repository with a local stub model showed `clampBudget` cutting the 100k budget to 4097 tokens: tokenx answers 4097 for every unknown model and 8192 for `gpt-4o`, so trusting it as a ceiling discarded almost every candidate. `clampBudget` no longer consults `getModelContextSize`; the batch limit is the caller's number and the provider's real window is unknowable here. Three budget tests that pinned the old behaviour were rewritten to the new contract.
