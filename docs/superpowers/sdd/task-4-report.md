# Task 4 report — acquire, safe extraction, run store

Status: DONE. `npm test` green (101 tests, 5 files, pristine output), `npm run typecheck`
clean. Commit subject `feat(kernel): acquire archives safely and persist runs`.

## What was built

### `src/kernel/acquire.ts` (new, 415 lines)

- `resolveSource(input, opts?: { ref?: string }, deps?: AcquireDeps): Promise<ResolvedSource>`
  - `https://github.com/<o>/<r>` (also scheme-less, `.git`, trailing slash) → archive.
  - Optional `/tree/<ref>/<path>` → `ref` and `subpath` (trailing slash trimmed, leading
    slash trimmed).
  - Ref precedence: `opts.ref` > `/tree/<ref>` > `releases/latest` `tag_name` > default
    branch. Nothing about a `/tree/` URL touches the network: the user already named the
    ref.
  - Release URL: `tarball_url` from the payload when it is a non-empty string, otherwise
    `https://codeload.github.com/<o>/<r>/tar.gz/<tag>`.
  - Any failure of the release lookup (throw, non-OK status, missing `tag_name`, bad JSON)
    falls back to `https://codeload.github.com/<o>/<r>/tar.gz/HEAD` with
    `ref = 'HEAD@<YYYY-MM-DD>'` (UTC, from `deps.now`).
  - Non-GitHub `http(s)` URL → accepted as-is, `ref = opts.ref ?? 'HEAD@<date>'`, no fetch.
  - Existing directory → `kind: 'local'`, `path = path.resolve(input)`, and `sha` =
    sha256 over `<repo-relative path>\0<size>` lines, sorted. Symlinks are not followed.
  - Anything else (`git@github.com:o/r.git`, garbage, empty) throws
    `anatomy: cannot resolve source "<input>" (...)`. There is no `git` code path at all.
- `downloadArchive(source, destFile, deps?) : Promise<{ sha; bytes }>` — the only place an
  archive body is fetched. Non-OK status → `anatomy: download failed (<status>) for <url>`.
  Not in the brief's interface list; added because "acquire repository" is otherwise
  incomplete and because `ResolvedSource.sha` cannot be filled any other way.
- `deriveRunId({ sha, ref, subpath, engineVersion })` — sha256 over a recursively
  key-sorted JSON string, first 12 hex chars.
- `extractTarSafe(archivePath, destDir): Promise<{ entries; bytes }>` — hand-rolled tar
  reader on `node:zlib`, no system `tar`.
- `export type AcquireDeps = { fetchImpl?: typeof fetch; now?: () => Date }`. Every network
  call goes through `deps.fetchImpl` (default `globalThis.fetch`), so tests never leave the
  process.

### `src/store/runs.ts` (new, 109 lines)

- `openRun(baseDir, manifest): Promise<Run>` — `<baseDir>/<runId>/`, `manifest.json`,
  `tree/`, all idempotent (reopening keeps artifacts).
- `Run.write(name, value)` — `<name>.json`, atomic (temp file in the same directory +
  `rename`), temp removed if the write or rename fails. Non-JSON values are refused.
- `Run.read<T>(name)` — `null` on `ENOENT`, `anatomy: artifact "<name>" in <dir> is not
  valid JSON` on parse failure.
- Artifact names are one path segment (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`), so `..`,
  `nested/name`, `/abs`, `.hidden` and `''` are refused; `runId` is checked the same way.
- `closeRun(run, { keepTree })` — deletes `tree/` unless `keepTree: true`, never touches
  artifacts, idempotent.

### Tar coverage

| Feature | Handling |
| --- | --- |
| gzip vs plain | magic bytes `1f 8b` → `gunzipSync`, else parse as raw tar |
| 512-byte header layout | `name`, octal `size`, `typeflag`, `ustar` magic at 257, `prefix` at 345 |
| `ustar` prefix | `prefix + '/' + name` when magic is `ustar` |
| leading `./` | one occurrence stripped |
| GNU long name (`L`) | body becomes the next entry's name |
| pax (`x`) | consumed; a `path=` record becomes the next entry's name |
| pax global (`g`), GNU long link (`K`) | consumed and ignored |
| terminator | first all-zero block ends parsing |
| `0`/NUL/`7` | regular file |
| `5` | directory |
| `1` | refused: `unsafe entry: <name> (hard link)` |
| `2` | refused: `... (symbolic link)` |
| `3`/`4` | refused: `... (device node)` |
| `6` | refused: `... (fifo)` |
| anything else | refused: `... (unsupported typeflag "<c>")` |

Validation (per entry, before any write): empty name, NUL byte, `path.isAbsolute` or
`C:\`-style drive, any `..` segment (checked in both `/` and `\` splits), then
`path.resolve(destDir, name)` compared against `path.resolve(destDir) + path.sep`.

### Two passes, not one

`extractTarSafe` parses and validates **every** entry into a plan, and only then creates
directories and writes files. That is what makes the stated contract literally true: a
rejected archive leaves `destDir` empty even when the offending entry is the last one, and
no entry can be written before a later entry has been validated. `destDir` itself is
created first (empty), so the caller can `readdir` it after a rejection.

## RED / GREEN evidence

RED, before the modules existed:

```
FAIL  tests/acquire.test.ts  Error: Failed to load url ../src/kernel/acquire.js ... Does the file exist?
FAIL  tests/runs.test.ts     Error: Failed to load url ../src/store/runs.js ... Does the file exist?
 Test Files  2 failed (2)   Tests  no tests
```

GREEN, first implementation:

```
 ✓ tests/runs.test.ts (8 tests)
 ✓ tests/acquire.test.ts (29 tests)
```

Because a first-try green is weak evidence, the safety tests were checked against a
deliberately broken implementation (the three checks in `safeTarget` removed, keeping only
`path.resolve`). Result:

```
× rejects fixtures/evil/abs.tar and leaves nothing behind
× rejects fixtures/evil/dotdot.tar and leaves nothing behind
× rejects fixtures/evil/symlink.tar and leaves nothing behind
× names the offending entry and why it was refused
× rejects a name that only escapes once resolved
 Tests  5 failed | 24 passed (29)
```

The file was restored byte-identically (`diff -q` against the backup) afterwards. Note the
`abs.tar` case really did create `/tmp/anatomy-abs-escape.txt` under the mutation, i.e. the
fixture is a live escape, not a decorative one; the file was deleted.

Two assertions were tightened while doing this (a tautological sha expectation was replaced
with the real digest `349438e5…f8d7c`, and the `./`-prefix test now asserts
`readdir(dest) === ['pkg']`).

Independent verification of the fixtures, outside vitest:

```
$ tar -tvf tests/fixtures/evil/abs.tar
-rw-r--r--  0 root root 3 Jan  1  1970 safe/ok.txt
-rw-r--r--  0 root root 6 Jan  1  1970 /tmp/anatomy-abs-escape.txt
$ tar -tvf tests/fixtures/evil/dotdot.tar
-rw-r--r--  0 root root 3 Jan  1  1970 safe/ok.txt
-rw-r--r--  0 root root 6 Jan  1  1970 ../../anatomy-dotdot-escape.txt
$ tar -tvf tests/fixtures/evil/symlink.tar
-rw-r--r--  0 root root 3 Jan  1  1970 safe/ok.txt
lrw-r--r--  0 root root 0 Jan  1  1970 safe/link -> /etc/passwd
```

Byte stability: `shasum tests/fixtures/evil/*.tar` is identical before and after a test run
(`591418c1…`, `ac31d80f…`, `1c14d329…`), so the committed fixtures never churn.

Real-archive check (manual, not committed): a `tar -czf` archive produced by macOS bsdtar
from a tree containing a Unicode filename and nested directories — i.e. `ustar` magic plus
pax `x` headers carrying `path=` — extracted byte-correct through `extractTarSafe`
(`entries: 10`, `bytes: 825`, the Unicode file landed at the right path). This is what
convinced me pax `path` handling had to be real rather than "skip the header": skipping it
would have dropped the long name and written the truncated placeholder instead.

Final state:

```
 ✓ tests/canonicalize.test.ts (22)
 ✓ tests/runs.test.ts (8)
 ✓ tests/acquire.test.ts (30)
 ✓ tests/scope.test.ts (32)
 ✓ tests/cli.test.ts (9)
 Test Files  5 passed (5)   Tests  101 passed (101)
npm run typecheck → exit 0, no output
```

## Files

- `src/kernel/acquire.ts` — new. `resolveSource`, `downloadArchive`, `deriveRunId`,
  `extractTarSafe`, `AcquireDeps`, `FetchLike`, `ResolvedSource`.
- `src/store/runs.ts` — new. `openRun`, `closeRun`, `Run`, atomic artifact writes.
- `tests/acquire.test.ts` — new, 30 tests: release resolution, `tarball_url` preference,
  `/tree/` refs, `HEAD@date` fallbacks (throw / 404 / no tag), non-GitHub URL, local tree
  hash (stable, changes with content), reject of `git@` and garbage, `downloadArchive`
  (sha + bytes + 503), `deriveRunId` (stability, key order, per-field sensitivity), the
  three malicious fixtures (reason + empty `destDir` + no file outside), hardlink/device/
  fifo rejection, prefix/`./`/long-name/pax/plain-tar/nested round-trips.
- `tests/runs.test.ts` — new, 8 tests: layout, manifest round-trip, reopen, last-write-wins,
  no `.tmp` residue, `null` vs malformed JSON, artifact-name refusal (5 names), non-JSON
  value, `closeRun` (default, `keepTree`, twice).
- `tests/helpers/tar.ts` — new, 130 lines: deterministic 512-byte header writer plus
  `file`/`dirEntry`/`symlink`/`hardlink`/`device`/`fifo`/`longName`/`pax`/`tar`/`gzip`.
  Not collected by vitest (`tests/**/*.test.ts` only) but typechecked by
  `tsconfig.test.json`.
- `tests/fixtures/evil/{abs,dotdot,symlink}.tar` — new, generated by the test suite from
  the helper (deterministic bytes, `mtime` 0), then committed. Each holds a benign
  `safe/ok.txt` **first**, so a write-as-you-parse implementation cannot pass the
  "destination is empty" assertion.

No existing file was modified: `git status` shows only new paths. `src/cli.ts`,
`src/kernel/canonicalize.ts`, `src/kernel/scope.ts`, `src/contracts/types.ts` untouched, and
no type was missing (only `ResolvedSource`/`AcquireDeps`/`FetchLike`/`Run` were added, all
in the new modules).

## Self-review

- No shelling out anywhere: the only processes anatomy would spawn are none. No `npm
  install`, `setup`, or tests are ever run against the target repository; extraction only
  writes bytes under `destDir`.
- Extraction ignores the `mode` field entirely: files are created with the process default
  (`0o666 & ~umask`), so no setuid/setgid bit and no symlink can come out of an archive.
  The cost is that the executable bit of extracted files is not preserved — irrelevant for
  reading source, noted in case a later task wants to run something (it must not).
- Header checksums are not verified, and duplicate names are allowed (last entry wins). Both
  deliberate: we are not trying to authenticate the archive, only to bound where its bytes
  can land.
- Artifact writes use the same directory for the temp file, so `rename` is atomic on the
  same filesystem, and the temp name is `<target>.<pid>.<random>.tmp`.
- Test-only network is fully injectable: every `resolveSource` / `downloadArchive` test
  passes a `fetchImpl`, and several of them assert the fake was called zero times. No test
  can silently hit the network and still pass.

## Concerns

1. **`sha` is empty for archive sources until download.** `deriveRunId` therefore collapses
   two different snapshots of the same `ref` (e.g. a branch tip that moved) into one run id.
   The pipeline must call `downloadArchive` and put its `sha` into the manifest/`deriveRunId`
   input, not the pre-download `''`. Worth pinning in whichever task wires the CLI.
2. **Deviation from the brief:** the brief says the local tree digest is the first 12 hex
   chars; I used the full 64 hex sha256 for both kinds of source (the parent's binding
   decision did not ask for truncation, and only `deriveRunId` truncates). If 12 was meant
   literally, `hashTree` needs a `.slice(0, 12)`.
3. **Ref precedence was ambiguous** between a `/tree/<ref>` in the URL and
   `releases/latest`. I made the URL win. If the release lookup was meant to be
   authoritative, the subpath test (`/tree/v9/packages/core`) encodes the wrong choice.
4. **Tar edge cases I am not certain about:**
   - base-256 encoded sizes (files ≥ 8 GiB) are rejected with an error rather than decoded.
   - Only the first zero block terminates; a single trailing zero block is accepted, and a
     tail shorter than 512 bytes is ignored. A malformed archive that continues after the
     terminator is therefore silently truncated instead of refused.
   - `prefix` is read on any header whose magic starts with `ustar`, including old-GNU
     (`ustar ` + version ` \0`) archives. Old-GNU tars can use the same bytes for other
     purposes in some variants (rare); a real old-GNU sample was not tested.
   - A sparse-file entry (`GNU.sparse.*` pax records / typeflag `S`) is not understood: it
     would be written as an ordinary file with a too-short body (typeflag `S` is refused, so
     the pax form is the risk).
   - A pax `size=` record is ignored; only `path=` is honoured. Archives whose size record
     disagrees with the header would be truncated silently.
   - `x` header ordering assumes the metadata entry immediately precedes its target (true of
     every archiver I checked, not guaranteed by the format).
5. **TOCTOU / pre-existing files.** Name validation is path-based. If `destDir` were not
   private — e.g. a previous run left a symlink inside it — a write could follow it. The
   contract is that `destDir` is a fresh private directory (the run's `tree/`), which the
   caller must guarantee; `extractTarSafe` does not `realpath`-check existing components.
6. `closeRun` trusts `run.treeDir`; a hand-built `Run` object could point it anywhere. Only
   `openRun`-created values are meant to be passed.
7. The malicious-archive test asserts `exists('/tmp/anatomy-abs-escape.txt') === false`,
   which is meaningful on this platform only. It is a positive check on a POSIX path, not a
   portability claim.
8. This report lives under `.superpowers/`, which is gitignored, so it is not part of the
   commit.

## Fix round 1 (finished by controller)

The implementer subagent was cut off mid-fix (43 tool calls, uncommitted tree, one failing test and one type error). The controller completed the remainder: `closeRun`'s treeDir guard (`src/store/runs.ts`), and a `fetchStub` argument typo in `tests/acquire.test.ts:274`. Coverage for the other ten items came from the subagent's work before it stopped; the re-review verifies each one.

Verified: `npm test` 124 passed, `npm run typecheck` clean.
