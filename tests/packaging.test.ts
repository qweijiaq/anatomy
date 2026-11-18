/**
 * What the package would actually ship.
 *
 * `bin` points at `dist/cli.js`, so the published thing is the built CLI. Without a
 * `files` list npm ships whatever is not gitignored — measured here at 336 files,
 * including 73 test files and 64 eval fixtures. A package whose install pulls down
 * its own test suite is not a package, it is a checkout.
 *
 * The check is a dry run rather than a manifest assertion: `npm pack` is the thing
 * that decides, so the test asks it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')

/**
 * Every path `npm pack` would include, from its dry-run listing.
 *
 * `dist/` is what ships, so the tarball is only meaningful once it exists: this
 * builds if a previous `npm run clean` removed it, rather than asserting against a
 * half-empty package and calling it a packaging bug.
 */
function packed(): string[] {
  // Build when either artifact the tarball is asserted to contain is missing. Checking
  // only for `dist/cli.js` was not enough: `npm run verify` runs the suite *before* its
  // build step, so on a tree whose `dist/` predates the sidecar copy — or whose last
  // build stopped between `tsc` and `copy-sidecar` — this test failed with "the package
  // does not ship the Python sidecar" against a source tree that does. That is a
  // packaging assertion reporting a stale directory as a product defect.
  const sidecar = path.join(ROOT, 'dist', 'kernel', 'structure', 'python_index.py')
  if (!existsSync(path.join(ROOT, 'dist', 'cli.js')) || !existsSync(sidecar)) {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 })
  }
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
  return (parsed[0]?.files ?? []).map((file) => file.path)
}

describe('what npm would publish', () => {
  it('ships the built CLI and the text, not the working tree', () => {
    const files = packed()
    const outside = files.filter(
      (file) =>
        !file.startsWith('dist/') &&
        !['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE'].includes(file),
    )
    // Anything else is a decision someone has to make deliberately.
    expect(outside).toEqual([])
  })

  it('never ships tests, fixtures or eval data', () => {
    const files = packed()
    for (const prefix of ['tests/', 'eval/', 'renderer/', 'docs/', 'electron/']) {
      expect(files.some((file) => file.startsWith(prefix)), `${prefix} is in the tarball`).toBe(false)
    }
  })

  it('ships the Python sidecar the structure stage needs', () => {
    // Copied into dist by `npm run build`; without it `ana analyze` on a Python
    // repository fails at runtime for anyone who installed the package.
    expect(packed()).toContain('dist/kernel/structure/python_index.py')
  })
})

describe('the installed package actually runs', () => {
  /**
   * Found by installing the tarball rather than by reading it.
   *
   * `readVersion()` located `package.json` from `process.cwd()` and `__dirname`.
   * `dist/cli.js` is ESM, where `__dirname` is undefined, so an installed `ana` run
   * from any other directory threw `package.json not found for the anatomy engine` —
   * which is every invocation of an installed CLI. The package looked fine, packed
   * fine, and could not run.
   */
  it('resolves the engine manifest from the module, not the working directory', async () => {
    const versionModule = await import('../src/version.js')
    const fromElsewhere = process.cwd()
    try {
      process.chdir(require('node:os').tmpdir())
      // The important property: it does not depend on where the process was started.
      expect(versionModule.readVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      process.chdir(fromElsewhere)
    }
  })
})

describe('runtime dependencies', () => {
  /**
   * `dependencies` is what `npm install anatomy` downloads. It held `electron`,
   * `vite`, `react`, `react-dom` and three `@types` packages — the entire desktop UI
   * toolchain, several hundred megabytes, for a CLI whose bundled code imports two
   * packages. The tarball's own manifest looked unremarkable; the install did not.
   */
  it('contains only what the shipped code imports', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const deps = Object.keys((JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }).dependencies)

    // Everything `src/` — the code that becomes `dist/` — imports from outside Node.
    const imported = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(absolute)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const source = readFileSync(absolute, 'utf8')
        for (const match of source.matchAll(/from '([^.][^']*)'/g)) {
          const specifier = match[1] as string
          if (specifier.startsWith('node:')) continue
          imported.add(specifier.split('/')[0] as string)
        }
      }
    }
    walk(path.join(ROOT, 'src'))

    for (const name of imported) {
      expect(deps, `src/ imports ${name} but it is not a runtime dependency`).toContain(name)
    }
    // And nothing heavy rides along silently.
    for (const name of ['electron', 'vite', 'react', 'react-dom']) {
      expect(deps, `${name} must not be a runtime dependency of a CLI`).not.toContain(name)
    }
  })
})

describe('the window bridge', () => {
  /**
   * The renderer and the preload script are separate TypeScript programs with
   * separate tsconfigs, and `renderer/src/api.ts` declares the bridge shape by hand.
   * Nothing type-checks one against the other, so a method added to the preload and
   * forgotten in the renderer — or the other way round — compiles clean on both
   * sides and fails at runtime, in the window, for a user.
   *
   * Twenty rounds of work added `report.forget`, `surveys.list`, `surveys.diff` and
   * `app.pickFolder`. Each was correct, and nothing would have noticed if one had
   * not been.
   */
  it('exposes exactly what the renderer declares', async () => {
    const { readFileSync } = await import('node:fs')
    const preload = readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8')
    const api = readFileSync(path.join(ROOT, 'renderer/src/api.ts'), 'utf8')

    /** The namespaces and members of the `api` object literal in preload.ts. */
    const exposed = new Map<string, Set<string>>()
    let current: string | null = null
    for (const line of preload.split('\n')) {
      const namespace = /^  ([a-z][\w]*): \{$/.exec(line)
      if (namespace !== null) {
        current = namespace[1] as string
        exposed.set(current, new Set())
        continue
      }
      if (line === '  },') {
        current = null
        continue
      }
      const member = /^    ([a-z][\w]*):/.exec(line)
      if (current !== null && member !== null) exposed.get(current)?.add(member[1] as string)
    }

    /** The same, from the `AnaBridge` type the renderer codes against. */
    const bridgeBlock = /type AnaBridge = \{([\s\S]*?)\n\}/.exec(api)?.[1] ?? ''
    const declared = new Map<string, Set<string>>()
    let declaring: string | null = null
    for (const line of bridgeBlock.split('\n')) {
      const namespace = /^  ([a-z][\w]*): \{$/.exec(line)
      if (namespace !== null) {
        declaring = namespace[1] as string
        declared.set(declaring, new Set())
        continue
      }
      if (line === '  }') {
        declaring = null
        continue
      }
      const member = /^    ([a-z][\w]*)[(:]/.exec(line)
      if (declaring !== null && member !== null) declared.get(declaring)?.add(member[1] as string)
    }

    // A namespace on one side and not the other is the same failure, larger.
    expect([...declared.keys()].sort()).toEqual([...exposed.keys()].sort())
    for (const [namespace, members] of declared) {
      expect([...(exposed.get(namespace) ?? [])].sort(), `${namespace} drifted`).toEqual(
        [...members].sort(),
      )
    }
  })
})

describe('the packaged renderer is sandboxed by a policy', () => {
  /**
   * Found by loading the built page in Electron and asking it two questions.
   *
   * The main process installs a Content-Security-Policy through
   * `ses.webRequest.onHeadersReceived`, and the comment there said the packaged app
   * got the strict form. Measured on the built app: the hook fires for a `file://`
   * document, but the policy is not enforced — `new Function('return 1')()` ran.
   * The packaged renderer therefore had no CSP while the code claimed it did.
   *
   * A `<meta>` tag is enforced for `file://`, so the build injects one. This asserts
   * the tag is in the built document, which is what makes the claim true.
   */
  it('carries a Content-Security-Policy in the built document', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const built = path.join(ROOT, 'dist-renderer/index.html')
    if (!existsSync(built)) {
      execFileSync('npm', ['run', 'build:desktop'], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 })
    }
    const html = readFileSync(built, 'utf8')
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(policy).not.toBe('')
    // The three that matter for an app that renders model-authored text.
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).toContain("object-src 'none'")
  })
})

describe('every source file is typechecked by some config', () => {
  /**
   * Found by planting a type error in `electron/main.ts` and watching `typecheck`
   * pass. `tsconfig.json` covers `src`, `tsconfig.test.json` covers `src`/`tests`/
   * `eval`, and `tsconfig.desktop.json` covered only `renderer/src` — so the entire
   * `electron/` directory, four files including the main process and the preload
   * bridge, was never type-checked. `npm run build:desktop` bundles it with esbuild,
   * which strips types without reading them.
   *
   * A directory that no config includes is worse than a failing check: it looks
   * covered, and everything in it can be wrong.
   */
  it('has no directory outside all three configs', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const configs = ['tsconfig.json', 'tsconfig.test.json', 'tsconfig.desktop.json'].map((name) => {
      const raw = readFileSync(path.join(ROOT, name), 'utf8').replace(/\/\/.*$/gm, '')
      return (JSON.parse(raw) as { include?: string[] }).include ?? []
    })
    const included = (dir: string): boolean =>
      configs.some((roots) => roots.some((root) => dir === root || dir.startsWith(`${root}/`)))

    // Only directories that actually hold TypeScript. `scripts/` is `.mjs` and is
    // deliberately outside every config; listing it would fail for the right reason
    // in the wrong place.
    for (const dir of ['src', 'electron', 'renderer/src', 'tests', 'eval']) {
      expect(included(dir), `${dir} holds TypeScript and is in no tsconfig include`).toBe(true)
    }
  })
})

describe('the gate still guards what it claims to', () => {
  /**
   * `npm run verify` is the single thing everything else points at — the READMEs,
   * the transcripts, the evidence in every round of work. Nothing guarded it.
   *
   * A step can be deleted, or its assertions removed, and the script still exits 0
   * and still prints `VERIFY: PASS`. That is the same failure this project spent
   * several rounds fixing in the typecheck gate: a check that cannot fail is worse
   * than no check, because it is believed. This test pins the sections and a floor
   * on the number of assertions, so weakening the gate is a visible change.
   */
  const sections = [
    'tests',
    'typecheck',
    'build',
    'scan',
    'report (tree deleted)',
    'inspect',
    'mcp',
    'packed package',
    'sample',
    'forget',
  ]

  it('still runs every section it documents', async () => {
    const { readFileSync } = await import('node:fs')
    const script = readFileSync(path.join(ROOT, 'scripts/verify.sh'), 'utf8')
    for (const section of sections) {
      expect(script, `verify.sh no longer runs "== ${section} =="`).toContain(`== ${section}`)
    }
  })

  it('still asserts rather than merely running', async () => {
    const { readFileSync } = await import('node:fs')
    const script = readFileSync(path.join(ROOT, 'scripts/verify.sh'), 'utf8')
    const assertions = (script.match(/\bfail "/g) ?? []).length
    // Measured at 33. A drop means an assertion was removed; a rise is fine only if
    // someone meant it, and then this number moves in the same commit.
    expect(assertions).toBeGreaterThanOrEqual(30)
    expect(script).toContain('VERIFY: PASS')
  })

  it('fails loudly rather than exiting 0 with a verdict of FAIL', async () => {
    const { readFileSync } = await import('node:fs')
    const script = readFileSync(path.join(ROOT, 'scripts/verify.sh'), 'utf8')
    // `fail` must exit non-zero; a function that prints and returns would make every
    // assertion above decorative.
    // Single-line definition: `fail() { echo …; exit 1; }`.
    const failBody = /^fail\(\)\s*\{([^\n]*)\}/m.exec(script)?.[1] ?? ''
    expect(failBody).toContain('exit 1')
  })
})

describe('the window offers the zero-token path', () => {
  /**
   * `ana scan` costs nothing and the CLI has always had it; the window did not, so
   * the only way to look at a repository from the app was the full analysis, which
   * spends tokens. That is the wrong first step for an unfamiliar repository, and
   * the gap sat in `docs/desktop.md` as a known omission.
   *
   * The renderer is never mounted in the suite, so this checks the two halves that
   * can be checked here: the bridge exposes `analysis.scan`, and the document has a
   * control bound to it. The click itself was exercised in Electron against a real
   * scan — button present, two rows, no console errors.
   */
  it('exposes a scan through the bridge and a control that calls it', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8')).toContain('analysis:scan')
    expect(readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8')).toContain("ipcMain.handle('analysis:scan'")
    expect(readFileSync(path.join(ROOT, 'renderer/src/App.tsx'), 'utf8')).toContain('先扫一眼')
  })
})

describe('the report can leave the window', () => {
  /**
   * The report is not only what the window renders — it is a file at
   * `.ana/runs/<id>/report.md`, and the text is something people paste into an issue
   * or a note. Neither action existed: the app could show a report and nothing else,
   * so getting it out meant finding the directory by hand.
   *
   * Verified by driving the built window in Electron: clicking a history row renders
   * the tools, the copy button is present, and the reveal button reaches the IPC
   * handler with the right run id.
   */
  it('exposes reveal through the bridge and offers both actions', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8')).toContain('report:reveal')
    expect(readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8')).toContain("ipcMain.handle('report:reveal'")
    const app = readFileSync(path.join(ROOT, 'renderer/src/App.tsx'), 'utf8')
    expect(app).toContain('在文件夹中显示')
    expect(app).toContain('navigator.clipboard.writeText')
  })
})

describe('the window asks the same question the CLI asks', () => {
  /**
   * A provider that rejected every request produced `ok: true` from the window: the
   * run finished, the report was empty, and the page said nothing was wrong. The CLI
   * had already learned this and the window had not, because the check lived in
   * `src/cli.ts` rather than in the thing both surfaces call.
   *
   * There is no Electron test harness in this repository, so the mapping itself is
   * verified by driving the built app with a 401 stub (recorded in the commit that
   * introduced it). What a test can pin is that the window still consults the shared
   * judgement — removing the call is exactly how the defect happened.
   */
  it('main.ts turns a refused run into a failure rather than a report', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8')
    expect(source).toContain('describeRunFailure')
    // The window translates the shared English verdict for a Chinese screen, but it
    // must still be that verdict: a local `ok: true` here is how the defect shipped.
    expect(source).toMatch(/if \(failure !== ''\) return \{ ok: false, message: zhRunFailure\(failure\) \}/)
  })
})
