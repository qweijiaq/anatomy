# Task 7 report — structure: Python via a long-lived `ast` sidecar

Status: DONE. `npm test` green (174 tests, 8 files, pristine output), `npm run typecheck`
clean. Commit `4ec226f feat(kernel): index python via long-lived ast sidecar` on `mvp`
(parent `e1ed7ed`). Working tree clean apart from this report.

The brief file `task-7-brief.md` does not exist in
`.superpowers/sdd/2026-11-12-anatomy-mvp/`; the requirements in the task prompt were
followed as written.

## What was built

### `src/kernel/structure/python_index.py` (new, 218 lines, stdlib only)

Long-lived NDJSON server: `{"type":"index","files":[...]}` in, one reply line per file
out (`{"path","imports":[{"specifier","level"}],"symbols":[{"name","kind","line"}],"error":null}`),
`{"type":"exit"}` ends the loop. Stdout is flushed per file so a batch that stalls is
indistinguishable from a hang the parent can time out.

- **Never executes the target.** The only operation on an analysed file is
  `ast.parse(source, filename=path)`. No `compile`, no `exec`, no `import`, no
  `importlib` — the script imports nothing from the repository, only `ast`, `io`,
  `json`, `sys`, `tokenize` from the stdlib.
- **Decoding.** Raw bytes are read, a UTF-8 BOM is stripped, `tokenize.detect_encoding`
  answers the PEP 263 question exactly as the interpreter would, and the decode falls
  back to `latin-1` on `UnicodeDecodeError`/`LookupError` (an unknown codec named by a
  cookie). `latin-1` can decode any byte string, so a mislabelled file is indexed
  rather than dropped.
- **Symbols.** `FunctionDef`/`AsyncFunctionDef` → `function`, `ClassDef` → `class`,
  module-level `Assign`/`AnnAssign` **with a value** → `const`, with destructuring
  (`Tuple`/`List`/`Starred`) expanded to one symbol per name. `line` is `node.lineno`
  (1-based). Function and class bodies are never entered; class members are not
  symbols.
- **Guarded blocks.** One level of `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:`
  and `try:` (with `except ImportError` / `ModuleNotFoundError`, or a bare `except:`)
  is descended into **for imports only** — that is where real dependency edges hide.
  Declarations are not collected there: a name that exists only on one branch is a
  fact about one environment, not a stable top-level declaration.
- **Imports.** `Import` → each alias name at level 0; `ImportFrom` → `'.'*level + module`
  with `level` (`node.level or 0`). Deduped per specifier. `TRY_TYPES` is built with
  `getattr` so `ast.TryStar` (3.11+) is covered without breaking 3.9.
- **Tolerance.** Any per-file exception (read failure, `SyntaxError`, `RecursionError`
  from a pathological expression) becomes a reply with `error` set to
  `"<ExceptionName>: <one line>"[:200]`; the loop continues.

### `src/kernel/structure/python.ts` (new, 403 lines)

- `indexPython(root, scope, options?: { pythonPath?: string; timeoutMs?: number }): Promise<StructureIndex>`.
  Files are `scope.files` whose `detectLanguage` is `py` (so `*.pyi` is out), sorted by
  path before the batch so the request — and the run — is deterministic.
- **One child per run.** `spawn(pythonPath ?? 'python3', [python_index.py], {stdio:['pipe','pipe','pipe']})`,
  all paths sent in one NDJSON line, `{"type":"exit"}` + `stdin.end()` afterwards.
  Zero Python files in scope returns the empty index **without spawning**. The script
  is located with `new URL('./python_index.py', import.meta.url)`, so it works from a
  tsx/vitest checkout as well as from `dist/`.
- **Protocol client.** Line-buffered stdout; a line is a reply only if it parses as JSON
  with a string `path` that was requested, first reply per path wins. `wanted`/`replies`
  are keyed by the absolute path that was sent, mapped back to the scope-relative path
  for the index. Junk lines (a warned interpreter, an echoed request) are ignored.
  Unread stderr is drained so a chatty child cannot wedge on a full pipe. `stdin`
  carries a no-op `error` handler so the EPIPE of a dead child is not an unhandled
  event.
- **Resolution.** Relative only (`level > 0`): level 1 is the importing file's own
  directory, each extra dot climbs one directory (climbing past the root → `null`).
  The dotted module is then probed as `<p>.py` and `<p>/__init__.py` against the kept
  path set. `resolved` is only set when the target is a module this pass emitted;
  a relative import that lands on nothing increments `unresolved` once; an absolute
  import never does.
- **Four endings, all data.** `replies` (success), `missing` (spawn `ENOENT`/`EACCES`,
  or a synchronous throw → `{modules:[],symbols:[],unresolved:0,notes:['python3 not found; python files unanalyzed']}`),
  `timeout` (→ `python indexer timed out after <ms> ms`), `closed`
  (→ `python indexer exited unexpectedly (code <n>)`). Partial replies are still
  indexed in the last two cases; the note says what was cut off.
- **Reaping.** `runBatch` has a `finally` that always awaits `stopSidecar`, so a throw
  anywhere in the parent still ends the child. `stopSidecar` asks politely
  (`stdin.end('{"type":"exit"}\n')`, which also closes the pipe so a protocol-ignorant
  child sees EOF), waits for `exit` **or** `close` (a child that never spawned emits
  no `exit`), and `SIGKILL`s after a 1 s grace. It resolves only once the child is
  gone. A module-level registry plus a one-shot `process.once('exit', …)` hook
  `SIGKILL`s anything still live if the run itself is torn down.
- One aggregate note `parse errors in <n> files` at the end, matching `ts.ts`. A file
  with a parse error becomes `{path, imports: []}` — it exists in the tree, and
  dropping it would leave every edge into it dangling. Modules sorted by path,
  symbols by path/line/name.

### `src/kernel/structure/index.ts`

`export { indexPython, type PythonIndexOptions } from './python.js'` next to
`indexTypeScript`; `mergeIndexes` needs no change.

### `src/kernel/profile.ts` (carry-over)

`ipynb` removed from `NON_CODE_EXTENSIONS`, with the comment explaining why: a notebook
holds code this tool cannot read, so silencing it made a notebook-only repository report
no caveat at all. `tests/profile.test.ts` gained the matching test
(`unanalysed language: other (ipynb) (100%)`); the existing furniture test is untouched
and still passes (no fixture there used `.ipynb`).

## RED / GREEN

- **RED.** `tests/structure-python.test.ts` written first (11 tests) + the profile test.
  `npx vitest run` → `TypeError: indexPython is not a function` ×11 and the profile
  test failing on the missing `ipynb` caveat: `Tests 12 failed | 23 passed`.
- **GREEN.** Implementation added, then a 12th test (`an interpreter that dies before
  answering`) after hardening `stopSidecar` to also wait for `close`. Full suite:
  174 tests / 8 files pass, pristine output; `tsc --noEmit` + `tsc -p tsconfig.test.json`
  clean. Committed immediately afterwards.

## Test coverage (`tests/structure-python.test.ts`, 12 tests)

Fixture package `pkg/` (`__init__.py`, `core.py`, `util.py`, `types.py`) plus
`broken.py`, a PEP 263 `legacy.py`, a BOM `bom.py`, and non-Python files:

1. absolute (`json`, `typing`, `fastjson`), package-relative (`.`, `.util`, `.types`)
   and unresolvable (`.missing` → `unresolved === 1`) imports;
2. symbol list per file (line numbers pinned, function bodies and class members absent);
3. descent into `if TYPE_CHECKING:` and `except ImportError:` produces edges;
4. a syntax error is one aggregate note and every other file is still indexed;
5. the latin-1 cookie yields `TITLE`/`café` (`caf\u00e9`) and the BOM yields `VALUE`,
   with no extra parse errors;
6. scope filtering + determinism (two runs, identical modules/symbols);
7. **spawn counting**: a fake `/bin/sh` interpreter appends its own pid to a log then
   `exec`s the real sidecar — 7 Python files, **1** spawn;
8. a fake interpreter that `exec`s `/bin/cat` never answers → timeout note,
   no throw, and `process.kill(pid, 0)` proves the child is gone **before the promise
   settles**;
9. a fake interpreter that `exit 3`s → note `exited unexpectedly (code 3)`, child gone;
10. `pythonPath: '/nonexistent/python3'` → the exact not-found index;
11. a non-executable override (`chmod 0644`) → same result;
12. a scope with no Python → empty index and **no** spawn log file at all.

## Self-review

- Long-lived, batch-fed: one child for the whole run, asserted by counting starts.
- Execution constraint holds: `python_index.py` imports only stdlib modules and calls
  `ast.parse`; nothing from the analysed tree is imported, compiled or run.
- Reaping is structural (`finally` + `exit`/`close` race + `SIGKILL` grace), and two
  tests assert the pid is dead rather than trusting the code path.
- Every failure mode is a note, never a rejection: missing/non-executable interpreter,
  timeout, early exit, per-file error.
- `resolved` still means "there is a `ModuleNode` at this path", the same rule `ts.ts`
  keeps, so consumers never guard a dangling edge.
- Determinism: request order, output order and note order are all fixed; no env vars,
  no temp files, no cwd dependence (absolute paths only).

## Concerns

1. **`dist/` does not ship the sidecar.** `npm run build` is `tsc`, which emits `.js`
   only, so `dist/kernel/structure/python_index.py` will not exist and `indexPython`
   would report `python indexer exited unexpectedly` from a built CLI. Fix is one line:
   `"build": "tsc && cp src/kernel/structure/python_index.py dist/kernel/structure/python_index.py"`.
   Not done here to keep the diff inside the task; it matters as soon as `cli.ts` wires
   Python in (which this task is not allowed to touch).
2. **`from . import name` resolves to the package, not the submodule.** Per the binding
   decision the dotted module is resolved, and for an empty module that is the package
   `__init__.py`; Python itself would also import `pkg/name.py`. Resolving through the
   imported aliases is a real refinement, but it is a *guess-free* one only when the
   file exists, so it was left out rather than half-done. `from . import util` therefore
   yields `pkg/__init__.py`, not `pkg/util.py`.
3. **Protocol edges.** Only one batch per child is ever sent — the child is capable of
   more, but nothing exercises that, so a future second-batch caller must re-derive the
   `wanted` set. Replies are matched by path, so an out-of-order or duplicated reply is
   handled. A child that writes a partial line then hangs is caught by the timeout, not
   by the framing. Absolute paths go over the wire; a path containing a newline would
   break nothing (JSON escapes it) but would be unreadable in a log.
4. **Reaping on macOS.** Verified empirically: `process.kill(pid, 0)` throws after every
   terminal path, and `exec` in the fake interpreter keeps the logged pid equal to the
   spawned pid, so the assertion is about the real process. Not covered: a sidecar that
   forks a grandchild holding the pipe (would delay `close`; the `exit` listener and the
   1 s `SIGKILL` still apply), and `SIGINT`/`SIGTERM` on the parent — only `process.exit`
   is hooked, so Ctrl-C relies on the `finally` in `runBatch` having already run.
5. **Timeout semantics.** `timeoutMs` bounds the whole batch, not per file. For a very
   large tree the default 30 s is a batch budget, so it may be too tight for a 5k-file
   repository on a cold disk; the note names the budget so the number is never a mystery.
6. **Note wording.** A file that cannot be *read* (permission, race) arrives as an
   `error` reply and is counted in `parse errors in <n> files`, because the protocol
   carries one error channel per file. `ts.ts` distinguishes `could not read` from
   `parse errors`; a second error code in the reply would restore that distinction if
   it turns out to matter.

## Fix round 1 (committed by controller)

The implementer subagent stopped while wiring the build copy step (41 tool calls). The tree it left was green: `npm test` 179 passed, `npm run typecheck` clean, and `npm run build` copies `python_index.py` into `dist/kernel/structure/`. Committed unchanged; the re-review verifies each of the six items against the diff.
