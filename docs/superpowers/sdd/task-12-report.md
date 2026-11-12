
## Committed by controller

The implementer subagent stopped while checking RED/GREEN (41 tool calls) without committing. Tree was green: `npm test` 415 passed, `npm run typecheck` clean. Committed unchanged; the review verifies each decision against the diff.

## Fix round 1

Branch `mvp`, from HEAD `b00bc3c`. Tests extended first; RED observed, then source fixed; GREEN observed.

### 1 [Important] Model text re-injected into the retry prompt

`src/writing/synthesis.ts`: added a module constant `UNUSABLE_REPLY = 'the reply could not be read as JSON'` and used it as the repair reason for `ModelReplyError`, replacing `messageOf(error)`. `messageOf` is gone, so no error text reaches `repairNote`. The comment states why: a `ModelReplyError` embeds the model's own truncated reply and V8 `JSON.parse` messages quote the body, so echoing either re-injects untrusted text as prompt instructions. This restores the invariant documented at `synthesis.ts:212` and the withholding done in `client.ts:309-311`.

Cover: `tests/writing-synthesis.test.ts` — `never puts model text back into the repair prompt`: first turn throws `ModelReplyError('model reply content is not JSON: {"problem":"SENTINEL-REPLY-TEXT"')`, second turn succeeds; asserts two calls, `calls[1].user` does not contain the sentinel, and the second reply is accepted.

### 2 [Important] Affinity borrowed a score from an unrelated file

`src/writing/rank.ts`: `affinityScore` now builds the set of `pathKey`s from the point's own evidence and skips any candidate not on one of them; with no cited path it returns `null`, so `scoreOf` falls through to `minimumScore`. Module header and the `KIND_AFFINITY` doc comment updated to say "the best score among the candidates on its own evidence paths".

Cover: `tests/writing-rank.test.ts` — `does not borrow an affinity score from a file the point never cites`: point `borrowed` (architecture, cites `src/ghost.ts:3`) vs point `real` (testing, cites `src/t.ts:4`, candidate 0.8); candidates also include `src/z.ts` abstraction 0.9 and a 0.1 filler for the minimum. Expects `['real', 'borrowed']`; under the old repo-wide rule `borrowed` took 0.9 and won.

### 3 [Minor] A null element threw

`src/writing/rank.ts`: new `isObject` guard; `evidenceOf` filters non-object evidence items; `rankPoints` filters non-object points and non-object candidates before mapping. `mergeKeys` and `compare` only ever see objects now.

Cover: `tests/writing-rank.test.ts` — `skips non-object entries instead of throwing` (`[null, undefined, good]` returns `['good']`) and `skips a null evidence element instead of throwing` (still ranks, matched by its real citation).

### 4 [Minor] Client bug downgraded to the fallback

`src/writing/synthesis.ts`: the catch block still rethrows `MissingCredentialsError` and `ModelRequestError`, and now rethrows anything that is not a `ModelReplyError`; only `ModelReplyError` sets the reason and continues. A defect in our own code is no longer retried as if it were a bad reply.

Cover: `tests/writing-synthesis.test.ts` — `rethrows a client bug instead of spending a repair on it`: `TypeError` is rethrown (`rejects.toBe(bug)`) with exactly one call.

### 5 [Minor] Returned titles were trimmed copies

`src/writing/synthesis.ts`: `uniqueTitles` now returns `{ prompt, canonical }` — `prompt` is the trimmed, de-duplicated list used in the prompt, `canonical` maps each trimmed form back to the caller's original string. `parseReply(raw, titles, canonical)` matches on the trimmed form and pushes `canonical.get(key) ?? key`, and the fallback maps `titles.slice(0, MAX_TOP_FIVE)` through the same lookup. A returned `topFive` item is now identical to the caller's string.

Cover: `tests/writing-synthesis.test.ts` — `returns the caller's exact title, not the trimmed copy it matched on` (caller passes `'  padded title  '`, model answers `'padded title'`, result keeps the padded original) and `returns the caller's exact title in the fallback too` (both turns unusable, fallback still returns the originals).

### 6 [Minor] Tightened two weak assertions

- `tests/writing-synthesis.test.ts`: replaced `toMatch(/5/)` / `toMatch(/3/)` with literal summary lines: `- 模块数: 5`, `- 未解析导入: 3`, and `- 被依赖最多的模块: src/a.ts (3), src/c.ts (2), src/b.ts (1)`.
- `tests/writing-rank.test.ts`: the reversed-range test is now `treats a reversed range as no evidence, even against a verifiable point`. It pairs `reversed` (architecture, `src/a.ts:20-12`, an affine candidate worth 0.9 on that path) with `honest` (testing, `src/t.ts:4`, candidate 0.1) and asserts `['honest', 'reversed']`, then keeps the single-point case. The bad point now has a real score it must lose on verifiability, which is what the old test failed to prove.

### Commands and output

- RED (tests first, source unfixed): `npx vitest run tests/writing-rank.test.ts tests/writing-synthesis.test.ts` -> `Test Files 2 failed (2)`, `Tests 7 failed | 25 passed (32)` (the new cases: sentinel in repair prompt, borrowed affinity, null point, null evidence, client bug rethrown, two padded-title cases; the literal-prompt and reversed-pair assertions did not fail on their own).
- GREEN (same two files): `Tests 32 passed (32)`.
- Full suite: `npm test` -> `Test Files 16 passed (16)`, `Tests 422 passed (422)`.
- `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.test.json`) -> clean, no output.

Side effects: `.superpowers/` is not tracked by git (see commit); only the four source/test files are in the commit.
