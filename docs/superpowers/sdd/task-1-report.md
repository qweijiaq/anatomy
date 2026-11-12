# Task 1 report — 项目骨架与共享类型

Implemented by: controller (see ledger ruling R-7; two implementer subagents failed to complete)

## What was implemented

- `package.json` — name `anatomy`, ESM, version `0.0.1`, `engines.node >=22.14`, bin `ana` → `./dist/cli.js`, scripts `build`/`test`/`typecheck`, deps `tokenx`, devDeps `typescript@^5`, `vitest`, `tsx`, `@types/node`
- `tsconfig.json` — strict, `module`/`moduleResolution` nodenext, target es2022, `outDir dist`, `rootDir src`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`
- `vitest.config.ts` — `tests/**/*.test.ts`, node environment
- `src/contracts/types.ts` — all shared types plus `ReportInput` (R-1), `StructureIndex.notes` (R-2), `Evidence.id`, `Candidate.matched`, and the three defaults (`DEFAULT_LIMITS`, `DEFAULT_BUDGET_TOKENS`, `DEFAULT_TOP_K`, `DEFAULT_SLICE_MAX_LINES`). No runtime behaviour — types and constants only
- `src/cli.ts` — `runCli(argv, io?): Promise<number>` with `--version` / `--help` / bare / unknown handling; four known commands stubbed as "not implemented yet" with exit 2. Direct-execution guard uses the `pathToFileURL(process.argv[1]).href === import.meta.url` comparison (ruling R-5), not `import.meta.main`
- `tests/cli.test.ts` — 4 tests

## TDD evidence

RED (with `src/cli.ts` moved aside, so the module genuinely did not exist):

```
$ mv src/cli.ts /tmp/cli.ts.bak && npx vitest run tests/cli.test.ts
 FAIL  tests/cli.test.ts [ tests/cli.test.ts ]
 Test Files  1 failed (1)
      Tests  no tests
```

Expected: the suite cannot even collect, because `../src/cli.js` is missing.

GREEN:

```
$ mv /tmp/cli.ts.bak src/cli.ts && npx vitest run tests/cli.test.ts
 ✓ tests/cli.test.ts (4 tests) 2ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Typecheck:

```
$ npx tsc --noEmit
(clean, no output)
```

Note: the first `npm install` attempts failed for environment reasons, not code reasons — two network drops, then `EACCES` on `~/.npm/_cacache`. Resolved by installing with a project-local cache (`--cache ./.npm-cache`, ledger R-8).

## Files changed

```
package.json  package-lock.json  tsconfig.json  vitest.config.ts  .gitignore
src/cli.ts  src/contracts/types.ts
tests/cli.test.ts
```

Commit: `cb98f4d feat: scaffold anatomy with shared contracts and cli entry` (base `0d6675c`).

## Self-review findings

- `tsconfig.json` has `"include": ["src"]`, so `tests/` is **not** typechecked by `npm run typecheck`. Tests still run (vitest uses esbuild and strips types without checking). Left as specified by the plan; worth a later decision, not a Task 1 change.
- `require('../package.json')` resolves from `dist/cli.js` to the project root after build, and from `src/cli.ts` to the project root in tests. Both are correct, but it means `readVersion()` depends on `package.json` shipping next to `dist/`.
- `--help` exits 0 while bare invocation exits 2. The plan only specified the bare case; the asymmetry is deliberate (standard CLI behaviour).
- The four real commands are stubs on purpose. They exist so the switch has structure for Tasks 9 and 14 rather than accumulating a `default:`-only branch.

## Concerns

- R-7 stands: implementation is controller-performed. If a `code-reviewer` subagent also fails to complete, the independent-review gate degrades to machine checks plus self-review.

---

# Fix round 1

Commit: `0a141d7 fix(cli): address task-1 review findings` (base `cb98f4d`).

## Changes per finding

### 1 [Critical] missing shebang — `src/cli.ts`

`#!/usr/bin/env node` is now line 1 of `src/cli.ts`. tsc emits it verbatim into `dist/cli.js`, so the `bin: {"ana": "./dist/cli.js"}` artifact is executable.

### 2 [Important] symlinked entry point — `src/cli.ts`

The guard became a function that resolves symlinks inside a try/catch:

```ts
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    // Resolve symlinks so `node_modules/.bin/ana` matches the real module URL.
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}
```

A missing/bogus `process.argv[1]` can no longer crash startup.

### 3 [Important] unhandled rejection — `src/cli.ts`

```ts
if (isDirectRun()) {
  void runCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((err: unknown) => {
      process.stderr.write(`ana: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}
```

No `process.exit()` — in-flight writes (stdout pipes) still flush.

### 4 [Important] vacuous version test — `src/cli.ts` + `tests/cli.test.ts`

`readVersion()` now throws instead of falling back:

```ts
const pkg = require('../package.json') as { version?: unknown }
if (typeof pkg.version !== 'string' || pkg.version === '') {
  throw new Error('package.json has no "version" field')
}
return pkg.version
```

Tests read `package.json` independently (`readFileSync` + `JSON.parse`) and assert exact equality: `cap.out === `${packageVersion}\n`` and `readVersion() === packageVersion`.

### 5 [Important] tests not typechecked — `tsconfig.test.json` + `package.json`

New `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`"typecheck": "tsc --noEmit && tsc -p tsconfig.test.json"`.

Proven to bite: appending `const bad: number = "x"` to `tests/cli.test.ts` makes `npm run typecheck` fail with `tests/cli.test.ts(118,7): error TS2322: Type 'string' is not assignable to type 'number'`. (That probe was reverted by `git checkout`, which also reverted the new test file; it was rewritten identically before re-running.)

## Covering tests — `tests/cli.test.ts` (9 tests)

Existing 4 (version / bare / unknown command / `--help`) plus:

- `readVersion returns the exact package.json version`
- `built artifact > starts with a node shebang` — asserts the built first line is exactly `#!/usr/bin/env node`
- `built artifact > runs as an executable and prints the version` — `chmod 755` the build, spawn `dist/cli.js` itself (real shebang execution), expect status 0 and stdout === package version
- `built artifact > runs when invoked through a symlink` — symlink `dist/cli.js` as `<tmp>/ana`, spawn the link, expect status 0 and the version (this is the `node_modules/.bin` shape; it failed before the `realpathSync` fix)
- `built artifact > installs a rejection handler on the entry point` — structural check on the emitted JS (`.catch(` and `process.exitCode = 1`), because no CLI path rejects until Tasks 9/14 land

`beforeAll` runs the local `node_modules/typescript/bin/tsc` once (no `npx`, no network) and `chmod`s the output.

## RED / GREEN

RED after adding the tests, before any fix (build ran, artifact has no shebang, no realpath, no catch):

```
$ npx vitest run
 × built artifact > starts with a node shebang
 × built artifact > runs as an executable and prints the version
 × built artifact > runs when invoked through a symlink
 × built artifact > installs a rejection handler on the entry point
 Tests  4 failed | 5 passed (9)
```

RED for finding 4 specifically — with `readVersion()` temporarily hardcoded to `return '0.0.0'` (i.e. the old fallback behaviour), the new assertions fail while the old regex assertion would have passed:

```
$ npx vitest run -t version
 × ana cli > prints the package version on --version
 × ana cli > readVersion returns the exact package.json version
 × built artifact > runs as an executable and prints the version
 Tests  3 failed | 6 skipped (9)
```

GREEN:

```
$ npx vitest run
 ✓ tests/cli.test.ts (9 tests) 323ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

## Commands run

```
$ npx vitest run                 # green, no stderr noise
$ npm run typecheck              # tsc --noEmit && tsc -p tsconfig.test.json, clean
$ node /tmp/anacheck/dist/cli.js --version   # rejection-handler proof
```

The last one used a throwaway `/tmp/anacheck` with a `package.json` lacking `version` (removed afterwards), forcing `runCli` to reject through the same module-level `.catch`:

```
ana: package.json has no "version" field
exit=1
```

Before the fix that path was an unhandled rejection (stack trace, exit 1 via the runtime, no `ana:` diagnostic).

## Files changed (round 1)

```
src/cli.ts          shebang, realpath guard, rejection handler, readVersion throws
tests/cli.test.ts   9 tests incl. built-artifact + symlink smoke, exact version
tsconfig.test.json  new, typechecks src + tests + vitest.config.ts
package.json        typecheck runs both configs
```

## Residual concerns (round 1)

- The rejection handler is covered only structurally until a command can reject (Tasks 9/14); the `/tmp/anacheck` run above is the behavioural evidence for now.
- The smoke tests build into `dist/` on every vitest run (~300-400ms, single tsc invocation). `dist/` is gitignored, so no repo noise. If build time becomes an issue, gate the build on `dist/cli.js` being absent — deliberately not done to keep the artifact assertion honest.
- `readVersion()` now throws, so a broken install of `package.json` yields `ana: package.json has no "version" field` on stderr with exit 1 instead of printing `0.0.0`.
