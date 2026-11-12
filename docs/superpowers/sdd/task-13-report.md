
## Committed by controller

The implementer subagent stopped mid-work (46 tool calls) without committing; tree green (`npm test` 448 passed, `npm run typecheck` clean). Committed unchanged; the review verifies each decision against the diff.

## Fix round 1

Five review findings, all in the render layer. Tests came first; the render suite
went RED with 11 failures before any source edit, then GREEN.

### 1 [Important] A dropped point vanished while the page said nothing was omitted

`buildReport` treated `normalizePoint(...) === null` as "nothing to do": the entry
left `points` and never reached `notRendered`, so `points: [[pointOf()]]` rendered
`points 0, notRendered []` and the tail printed "没有可核对证据的点：0 个" plus
"没有需要声明的遗漏".

Fix: every entry of `points` that fails to normalise now pushes a `notRendered`
record with our own reason, `MALFORMED_POINT_REASON` ('这一条不是学习点（points 里
出现了数组、null、字符串或其它非对象）'), under a positional label
`point-<index+1>` since the entry has no id. A `points` field that is not a list at
all (and is present) is likewise declared once with `MALFORMED_POINTS_REASON`, so
"the whole list was unusable" is not silence either.

`notRendered` therefore now means "input the page received but could not show",
which is what the tail has always claimed to count. Tests: `points: [[pointOf()]]`
(1 declared), `points: [null, null]` (2 declared), non-array `points`, and one
asserting no declared reason is ever the empty string.

### 2 [Important] The top five could name a point the page withholds

`brief` printed `topFive` verbatim. A title whose point had no followable citation
headed the page while its section was absent.

Fix: `brief` builds a `Set` of `prose(point.title)` over the *rendered* points and
appends `（未进正文）` to any top-five entry not in it. The entry is kept (it is what
the synthesis chose) but it no longer reads as something below. Matching is on the
same `prose()` normalisation the section headings use, so whitespace or backtick
differences between the list and the title cannot cause a false "absent". Test: a
mixed pair, one rendered and one withheld.

### 3 [Minor] A missing number rendered as a measured zero

`buildReport` copied stats through `count()`, which defaults to `0`; a run without
validation data claimed "已取证点占比：0.0%".

Fix: a separate `measurement()` reader returns `undefined` for a missing or
non-finite stat, `ReportTrust` is now `number | undefined` per field, and the
writers spell absence as `未知` (`percentText` and `numberText`). Counts of things
we actually enumerated (scope totals, language counts) still default to `0` —
there, zero is a reading. The JSON omits an unmeasured key rather than writing
`0`. Tests: markdown prints `未知` three times, JSON `trust` is `{}`.

### 4 [Minor] Blank strings became empty bullets

`stringList` kept `''` / `'   '` while `exclusionList` and `judgementList` dropped
blanks, so `skipped: ['', '  ']` produced bare "- 跳过：" bullets and flipped the
"there are omissions" branch.

Fix: `stringList` filters on `item.trim() !== ''`. That covers `skipped`, `notes`,
`topFive`, `unknowns`, `prereqs` and `avoidWhen` at once, and the declared-ness
test in `tail` now sees the real counts. Tests: blank `skipped`, blank `notes`.

### 5 [Minor] The heading hardcoded "5 件事"

Fix: `brief` derives the heading from `doc.topFive.length`, and the empty case
falls back to `## 最值得学的点` rather than "0 件事". The structure test's expected
heading moved from `5 件事` to `1 件事` accordingly, and a new test pins the count
and asserts `5 件事` no longer appears.

### Verification

- RED: `npx vitest run tests/render.test.ts` -> 11 failed | 24 passed (35).
- GREEN: same command -> 35 passed.
- `npm test` -> 17 files, 460 passed (was 448; +12 new cases).
- `npm run typecheck` -> clean (`tsc --noEmit` + test project).

Files changed: `src/render/json.ts`, `src/render/markdown.ts`, `tests/render.test.ts`.
No refactors, no new dependencies.
