# Task 2 report — canonicalize + line-addressed slice reads

Status: DONE_WITH_CONCERNS (one required edit to an existing config file, see Concerns)

## What was built

`src/kernel/canonicalize.ts` — the one and only place that decides what "the text of a
file" is. Four exports, no new dependencies:

- `canonicalizeFile(absPath: string): Promise<CanonicalFile>`
  - reads the bytes once; UTF-8 is decoded with a **fatal** `TextDecoder`, so invalid
    sequences throw and are retried with `buffer.toString('latin1')` and
    `encoding: 'latin1'` (never silently replaced with U+FFFD, which would poison
    snippets).
  - `hadBom` is detected on the raw bytes (`EF BB BF`) and the decoded `\uFEFF` is
    removed, so line 1 is snippet-comparable.
  - newline normalization: `/\r\n/g -> '\n'` then `/\r/g -> '\n'`.
  - trailing whitespace stripped per line with `/[ \t]+$/` (never `trim()`, which
    would eat indentation and shift snippet columns).
  - `lineCount` counts `\n`; a trailing newline does not create an extra line
    (`"a\nb\n"` -> 2); empty text -> 0. The canonical `text` keeps its trailing
    newline (it is the exact file text, only normalized).
  - `path` is echoed back exactly as passed in (not resolved) so downstream path
    joins against `Scope` entries stay byte-identical.
- `offsetOfLine(text, line): number` — 1-based line -> 0-based character offset.
  `RangeError` for non-integers, `line < 1`, and `line > lineCount`.
- `lineRangeOfSnippet(fileText, snippet): { startLine, endLine } | null` — indexOf
  first match only; `null` when absent **and** when `snippet === ''` (an empty
  snippet "matches" at offset 0, which would be meaningless evidence).
  A snippet ending in `\n` maps to the line of its last visible character.
- `readSlice(absPath, startLine, endLine, opts?: { maxLines?: number }): Promise<Slice>`
  — default `maxLines = DEFAULT_SLICE_MAX_LINES` (200, from `contracts/types.ts`);
  bounds are clamped into `1..lineCount` (never throws); `startLine > endLine` is
  swapped; when the clamped span exceeds `maxLines`, the head (`ceil(max/2)`) and
  tail (`max - head`) halves are kept and joined with a single `...` elision line,
  `truncated: true`; `startLine/endLine` still describe the full clamped request
  range. Empty file -> `{ startLine: 0, endLine: 0, text: '', truncated: false }`.

All shared types are imported from `../contracts/types.js` (nodenext, `.js` extension).

## TDD evidence

### RED

Fixtures written first (real bytes, verified with `xxd`):

```
tests/fixtures/encoding/crlf.ts      "export const a = 1\r\n...c = 3\r\n"   (3 lines, CRLF)
tests/fixtures/encoding/bom.ts       EF BB BF + "import { a } from './a'\nexport const a = 1\n"
tests/fixtures/encoding/latin1.ts    "// caf\xe9\nconst na\xefve = 1\n"      (0xE9, 0xEF latin-1)
tests/fixtures/encoding/trailing.ts  lines with trailing spaces/tab + "\t  keep indentation   "
```

`npx vitest run tests/canonicalize.test.ts` before implementation:

```
 ❯ tests/canonicalize.test.ts (0 test)
 FAIL  tests/canonicalize.test.ts [ tests/canonicalize.test.ts ]
Error: Failed to load url ../src/kernel/canonicalize.js ... Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN

`npx vitest run tests/canonicalize.test.ts`:

```
 ✓ tests/canonicalize.test.ts (16 tests) 5ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

(The brief's seven assertions are all present verbatim in spirit; nine more cover
indentation preservation, offsetOfLine happy path, first-match-only, multi-line
snippet span, empty snippet, exact slice text, clamping, head/tail truncation and
the 200-line default. Output is pristine — no warnings.)

`npm run typecheck`:

```
> tsc --noEmit && tsc -p tsconfig.test.json
(no output, exit 0)
```

Full suite `npm test`: 2 files / 25 tests passed.

## Files

Created
- `src/kernel/canonicalize.ts` (191 lines) — the four functions above.
- `tests/canonicalize.test.ts` (142 lines) — 16 tests.
- `tests/fixtures/encoding/crlf.ts`, `bom.ts`, `latin1.ts`, `trailing.ts` — real bytes.

Modified (see Concerns)
- `tsconfig.test.json` — added `"exclude": ["tests/fixtures"]`.

`src/cli.ts` and every other source file untouched.

## Self-review

- No second decoding/normalization path exists anywhere; `readSlice` reuses
  `canonicalizeFile` rather than reading the file itself. Nothing in the module
  imports from `src/cli.ts` or from any module outside `contracts/types.js`.
- `offsetOfLine` is defined in terms of the same `countLines` used by
  `canonicalizeFile`, so line numbers and character offsets cannot drift.
- Strictness: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` all
  clean; the only indexed access (`lines[i]`) is cast after the loop bound.
- `stripTrailingWhitespace` uses `split('\n')` + per-line replace and rejoins, so a
  trailing newline and interior blank lines survive unchanged; the explicit test on
  `\t  keep indentation` fails if anyone reintroduces `trim()`.
- Complexity: `countLines` is O(newlines); `lineRangeOfSnippet` is a single
  `indexOf` plus a prefix count, so validating many snippets against a large file
  stays linear per snippet. `readSlice` splits once per call (no cache) — fine for
  the MVP, and a cache would be the natural optimization if Task 11 shows it.

## Concerns

1. Required deviation: fixing `npm run typecheck` forced a one-line edit to the
   existing `tsconfig.test.json` (`"exclude": ["tests/fixtures"]`). The latin-1
   fixture is genuinely not valid UTF-8, so `tsc -p tsconfig.test.json` (which
   includes `tests/**`) reported `TS1490: File appears to be binary` plus syntax
   errors for the other fixtures. The alternatives were renaming the fixtures away
   from the `.ts` names the brief mandates, or leaving typecheck red; excluding the
   fixture directory is the least invasive option and is why this is reported as
   DONE_WITH_CONCERNS rather than DONE.
2. Truncated slices are not a contiguous substring of the file: `text` contains a
   `...` elision line while `startLine/endLine` still span the whole clamped range.
   Downstream (Task 11) must treat a `truncated` slice as "head and tail of this
   range", never as verbatim text, and must not derive evidence snippets from a
   truncated slice. The `...` marker is a module-private constant, not exported.
3. `lineRangeOfSnippet('' , '')` and any empty snippet return `null` by decision
   (the brief does not specify). If Task 10 needs empty snippets to be "valid", that
   check belongs in the validator, not here.
4. `hadBom` only recognizes the UTF-8 BOM by bytes; a latin-1 file whose first three
   bytes happen to be `EF BB BF` would be decoded as UTF-8 (they are a valid UTF-8
   BOM), which is the correct reading anyway.
5. Files are fully buffered in memory. Scope limits are expected to reject huge files
   before they reach this module; there is no streaming path.

## Fix round 1

Scope: the seven findings from the review of `2189272`. Branch `mvp`, base commit
`2189272`, fix commit `5218932`. Files touched: `src/contracts/types.ts`,
`src/kernel/canonicalize.ts`, `tests/canonicalize.test.ts`,
`tests/fixtures/encoding/cr.ts`, `tests/fixtures/encoding/bom-latin1.ts`,
`tsconfig.test.json`. No other files, no new dependencies.

### TDD trace

RED (`npm test` after test-only edit, before source edit):

```
 ❯ tests/canonicalize.test.ts (22 tests | 9 failed) 29ms
   × canonicalizeFile > strips a BOM that survived latin-1 decoding 3ms
   × canonicalizeFile > counts a whitespace-only final line without a trailing newline 1ms
   × canonicalizeText > normalizes CRLF and strips trailing whitespace on every line 0ms
   × canonicalizeText > strips one leading BOM 0ms
   × readSlice > returns a line-addressed slice with exact text 1ms
   × readSlice > clamps out-of-range bounds instead of throwing 1ms
   × readSlice > keeps head and tail halves when over maxLines 5ms
   × readSlice > truncates by default at 200 lines 4ms
   × readSlice > falls back to the default maxLines when maxLines is NaN or below 1 8ms
 Test Files  1 failed | 1 passed (2)
      Tests  9 failed | 22 passed (31)
```

One intermediate RED was a genuine signal, not a missing export: after the
`lineCount` fix but before the `offsetOfLine` fix, `offsetOfLine('const a = 1\n', 2)`
threw `RangeError` because `countLines('const a = 1\n')` is 1. See item 2 below for
how that was resolved.

GREEN (`npm test`):

```
 ✓ tests/canonicalize.test.ts (22 tests) 6ms
 ✓ tests/cli.test.ts (9 tests) 350ms
 Test Files  2 passed (2)
      Tests  31 passed (31)
```

`npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.test.json`) exits 0 with no
output.

### Per-item changes

1. [Critical] Truncated `Slice` self-inconsistency. `Slice` now carries
   `omitted: { startLine: number; endLine: number } | null`
   (`src/contracts/types.ts`), documented on the type: head text is
   `startLine..omitted.startLine-1`, tail text is `omitted.endLine+1..endLine`, and
   consumers must address lines through `omitted` rather than counting `text` lines
   because `...` is legal source in some languages. `readSlice` returns `null` when
   nothing was dropped (including the empty-file case) and, when truncating,
   `{ startLine: first + head, endLine: last - tail }` (`src/kernel/canonicalize.ts`).
   Tests: every `readSlice` test asserts `omitted`, including `toBeNull()` for the
   untruncated cases and the exact range for truncated ones.

2. [Important] `lineCount` losing a whitespace-only final line. New exported
   `canonicalizeText(raw)` runs BOM strip -> newline normalization -> `countLines`
   on the normalized text -> trailing-whitespace strip, and `canonicalizeFile` is now
   just decode + `canonicalizeText` + `hadBom`. Counting before stripping keeps
   `"const a = 1\n   "` at 2 lines while `text` is still `'const a = 1\n'`.
   Test: temp file with those exact bytes asserts `text === 'const a = 1\n'`,
   `lineCount === 2`, and `offsetOfLine(file.text, 2) === 12`.
   Consequence: `offsetOfLine` now treats a text ending in `\n` as having one extra
   addressable line start at `text.length` (the empty final line), since that is
   exactly the shape a whitespace-only final line canonicalizes to. `countLines`
   still uses POSIX semantics ("a trailing newline is not a line"), and genuine
   out-of-range input such as `offsetOfLine('a\nb', 5)` still throws `RangeError`.

3. [Important] Lone `\r`. New `tests/fixtures/encoding/cr.ts` with the raw bytes
   `61 0d 62 0d 63 0d`. Test asserts `lineCount === 3` and `text === 'a\nb\nc\n'`.
   (The existing `normalizeNewlines` already handled this; the fixture makes it
   regression-proof instead of untested.)

4. [Important] Weak truncation assertions. The `maxLines: 10` test now asserts the
   whole `text` (`[...bigLines(1,5), '...', ...bigLines(496,500)].join('\n')`) and
   `omitted` equals `{ startLine: 6, endLine: 495 }`. The default-`maxLines` test on
   a 500-line file asserts `text` is lines `1..100` + `...` + `401..500` and
   `omitted` equals `{ startLine: 101, endLine: 400 }`. Both would fail if a consumer
   could not reconstruct real line numbers from `omitted`.

5. [Important] BOM + latin-1 losing line 1. `TextDecoder('utf-8')` strips a BOM
   itself, so the old `startsWith(UTF8_BOM)` post-decode check was dead while the
   latin-1 path produced the `ï»¿` mojibake of the same three bytes. Now the latin-1
   fallback strips one leading `\u00EF\u00BB\u00BF` (documented as `MOJIBAKE_BOM`),
   and `canonicalizeText` strips one leading U+FEFF, so both paths are normalized.
   New fixture `tests/fixtures/encoding/bom-latin1.ts` is `EF BB BF` + `// caf\xe9\n`;
   test asserts `hadBom === true`, `encoding === 'latin1'`, `text === '// café\n'`.

6. [Minor but load-bearing] Pure `canonicalizeText(raw)`. Exported from
   `src/kernel/canonicalize.ts` as the single BOM -> newline -> trailing-whitespace
   pipeline; `canonicalizeFile` delegates to it, so Task 10 can validate
   model-supplied snippets on the same path. Tests: `'a = 1  \r\nb = 2\t\r\n'` ->
   `{ text: 'a = 1\nb = 2\n', lineCount: 2 }`, and `'\uFEFFa\n'` -> `{ text: 'a\n', lineCount: 1 }`.

7. [Minor] `maxLines: NaN`. `readSlice` uses the default unless
   `Number.isFinite(raw) && raw >= 1`. Test loops `NaN`, `0`, `-5` and asserts each
   behaves exactly like the default (200 lines, `omitted === {101, 400}`).

### tsconfig.test.json

The `exclude: ["tests/fixtures"]` entry is kept and now carries a comment explaining
why: fixtures are raw bytes (lone CR, invalid UTF-8, BOM) read by path, so
typechecking them only yields `TS1490: File appears to be binary` plus parser noise.

### Commands

```
npm test                 # 31 passed (2 files)
npm run typecheck        # exit 0, no output
git commit -m 'fix(kernel): make sliced evidence line-accurate and encoding-safe'
```

Commit `5218932` — `fix(kernel): make sliced evidence line-accurate and encoding-safe`.

### Residual concern

`readSlice` still derives its lines from `toLines(text)`, and for a file whose final
line is whitespace-only the canonical text is `"const a = 1\n"` while `lineCount` is
2. A slice requested as lines `1..2` of such a file therefore returns `text`
`'const a = 1'` with `endLine 2`. That is the same fact recorded by `omitted`-free
untruncated slices and does not affect any real source file (line 1 content and
line 2 empty); it is noted here rather than fixed because the review scoped item 2
to the count and it would otherwise change slice text for trailing-newline files.
