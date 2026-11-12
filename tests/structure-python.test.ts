import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import type { Scope, StructureIndex } from '../src/contracts/types.js'
import { selectScope } from '../src/kernel/scope.js'
import { indexPython } from '../src/kernel/structure/index.js'

// --- fixtures -------------------------------------------------------------

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** The sidecar the module itself runs; a fake interpreter forwards to it. */
const SIDECAR = fileURLToPath(new URL('../src/kernel/structure/python_index.py', import.meta.url))

/** The build step that puts the sidecar next to the compiled client. */
const COPY_SIDECAR = fileURLToPath(new URL('../scripts/copy-sidecar.mjs', import.meta.url))

/** The package root, for invoking its own scripts the way `npm run build` does. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  created.push(root)
  return root
}

async function repoOf(files: Record<string, string | Buffer>): Promise<string> {
  const root = await tempDir('anatomy-python-')
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return root
}

/**
 * A stand-in interpreter: it records its own pid, then becomes `tail`. The pid is
 * the process the module spawns, because `exec` replaces the shell in place.
 */
async function fakePython(tail: string, logPath: string): Promise<string> {
  const root = await tempDir('anatomy-fake-python-')
  const script = path.join(root, 'python3')
  await writeFile(
    script,
    ['#!/bin/sh', `printf '%s\\n' "$$" >> '${logPath}'`, tail, ''].join('\n'),
  )
  await chmod(script, 0o755)
  return script
}

async function indexOf(
  files: Record<string, string | Buffer>,
  options?: { pythonPath?: string; timeoutMs?: number },
): Promise<StructureIndex> {
  const root = await repoOf(files)
  const scope: Scope = await selectScope(root)
  return indexPython(root, scope, options)
}

/**
 * One repository that exercises every path at once: a package whose `__init__`
 * imports from a sibling, a module with absolute imports, an import under
 * `if TYPE_CHECKING:`, an import guarded by `try/except ImportError`, a relative
 * import naming a real module, one naming nothing, a class, a module-level
 * assignment, an async def, a file that does not parse, a PEP 263 cookie and a
 * BOM.
 */
const fixtureFiles = (): Record<string, string | Buffer> => ({
  'pkg/__init__.py': ['from .core import Widget', '', '__all__ = ["Widget"]', ''].join('\n'),
  'pkg/types.py': 'class Shape:\n    pass\n',
  'pkg/util.py': 'def helper():\n    return 1\n',
  'pkg/core.py': [
    'import json',
    'from typing import TYPE_CHECKING',
    '',
    'if TYPE_CHECKING:',
    '    from .types import Shape',
    '',
    'try:',
    '    import fastjson as fast',
    'except ImportError:',
    '    from .util import helper',
    '',
    'from . import util',
    'from .missing import gone',
    '',
    'VERSION = "1.0"',
    '',
    'class Widget:',
    '    def area(self):',
    '        return 1',
    '',
    'async def build(part):',
    '    total = 1',
    '    return part',
    '',
    'def helper_local():',
    '    nested = 1',
    '    return nested',
    '',
  ].join('\n'),
  'broken.py': 'def oops(:\n    pass\n',
  // A PEP 263 cookie: the raw byte 0xE9 is only legal source as latin-1.
  'legacy.py': Buffer.from(
    '# -*- coding: latin-1 -*-\nTITLE = "caf\u00e9"\ncaf\u00e9 = 1\n',
    'latin1',
  ),
  // A UTF-8 BOM, which is not source text until it is stripped.
  'bom.py': Buffer.from('\uFEFFVALUE = 1\n', 'utf8'),
  'README.md': '# widget\n',
  'src/index.ts': 'export const x = 1\n',
})

const moduleAt = (index: StructureIndex, target: string) => {
  const found = index.modules.find((module) => module.path === target)
  if (found === undefined) throw new Error(`no module for ${target}`)
  return found
}

const spelled = (index: StructureIndex): string[] =>
  index.symbols.map((symbol) => `${symbol.path}:${symbol.name}:${symbol.kind}:${symbol.line}`)

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// --- tests ----------------------------------------------------------------

describe('indexPython', () => {
  it('takes absolute imports as unresolved packages and relative ones as edges', async () => {
    const index = await indexOf(fixtureFiles())
    const core = moduleAt(index, 'pkg/core.py')

    // Only imports that name a file in this tree become an edge. A third-party or
    // stdlib module is not a failure, and neither is an absolute import that names
    // a sibling package: neither is counted in `unresolved`.
    expect(core.imports).toContainEqual({ from: 'pkg/core.py', specifier: 'json', resolved: null })
    expect(core.imports).toContainEqual({
      from: 'pkg/core.py',
      specifier: 'typing',
      resolved: null,
    })
    expect(core.imports).toContainEqual({
      from: 'pkg/core.py',
      specifier: 'fastjson',
      resolved: null,
    })
    // `from . import util` names a *member* of the package, not the package: the
    // alias is what identifies the module, so this is `pkg/util.py`.
    expect(core.imports).toContainEqual({
      from: 'pkg/core.py',
      specifier: '.',
      resolved: 'pkg/util.py',
    })
    expect(core.imports).toContainEqual({
      from: 'pkg/core.py',
      specifier: '.util',
      resolved: 'pkg/util.py',
    })
    expect(core.imports).toContainEqual({
      from: 'pkg/core.py',
      specifier: '.types',
      resolved: 'pkg/types.py',
    })
    // A relative import naming nothing on disk is the only unresolved edge here.
    expect(core.imports).toContainEqual({
      from: 'pkg/core.py',
      specifier: '.missing',
      resolved: null,
    })
    expect(index.unresolved).toBe(1)

    // A package's `__init__` imports through the same dots.
    expect(moduleAt(index, 'pkg/__init__.py').imports).toEqual([
      { from: 'pkg/__init__.py', specifier: '.core', resolved: 'pkg/core.py' },
    ])
  })

  it('collects module-level declarations and never descends into bodies', async () => {
    const index = await indexOf(fixtureFiles())

    expect(spelled(index).filter((line) => line.startsWith('pkg/'))).toEqual([
      'pkg/__init__.py:__all__:const:3',
      // `total` and `nested` live in function bodies; `json2 = None` in an except
      // branch is a runtime fallback, not a top-level declaration.
      'pkg/core.py:VERSION:const:15',
      'pkg/core.py:Widget:class:17',
      // A class member is not a top-level declaration.
      'pkg/core.py:build:function:21',
      'pkg/core.py:helper_local:function:25',
      'pkg/types.py:Shape:class:1',
      'pkg/util.py:helper:function:1',
    ])
  })

  it('descends one level into TYPE_CHECKING and ImportError guards', async () => {
    const index = await indexOf(fixtureFiles())
    const specifiers = moduleAt(index, 'pkg/core.py').imports.map((edge) => edge.specifier)

    // Both guarded imports are real dependency edges: a type-checking-only import
    // is the boundary a reader is looking for, and a `try: import x` fallback is
    // how a Python project states an optional dependency.
    expect(specifiers).toContain('.types')
    expect(specifiers).toContain('.util')
    expect(specifiers).not.toContain('.missing.anything')
  })

  it('notes a syntax error once and keeps indexing every other file', async () => {
    const index = await indexOf(fixtureFiles())

    // A file that does not parse has no recoverable imports, so it is reported as
    // an empty module — dropping it would make every edge into it dangle.
    expect(moduleAt(index, 'broken.py')).toEqual({ path: 'broken.py', imports: [] })
    expect(moduleAt(index, 'pkg/core.py').imports.length).toBeGreaterThan(0)
    expect(index.notes).toEqual(['parse errors in 1 files'])
  })

  it('honours a PEP 263 encoding cookie and strips a BOM', async () => {
    const index = await indexOf(fixtureFiles())

    // The cookie is what makes byte 0xE9 legal source; without it the file would
    // be a parse error. The BOM is not source text at all until it is removed.
    expect(spelled(index)).toContain('legacy.py:TITLE:const:2')
    expect(spelled(index)).toContain('legacy.py:caf\u00e9:const:3')
    expect(spelled(index)).toContain('bom.py:VALUE:const:1')
    // Only broken.py is a parse error: neither file above is one.
    expect(index.notes).toEqual(['parse errors in 1 files'])
  })

  it('indexes only the files the scope kept, in a deterministic order', async () => {
    const index = await indexOf(fixtureFiles())
    const first = await indexOf(fixtureFiles())

    expect(index.modules.map((module) => module.path)).toEqual([
      'bom.py',
      'broken.py',
      'legacy.py',
      'pkg/__init__.py',
      'pkg/core.py',
      'pkg/types.py',
      'pkg/util.py',
    ])
    expect(first.modules).toEqual(index.modules)
    expect(first.symbols).toEqual(index.symbols)
  })

  it('runs one interpreter for the whole run, not one per file', async () => {
    const root = await tempDir('anatomy-spawn-')
    const logPath = path.join(root, 'spawn.log')
    const pythonPath = await fakePython(`exec python3 '${SIDECAR}'`, logPath)

    const index = await indexOf(fixtureFiles(), { pythonPath })
    const spawns = (await readFile(logPath, 'utf8')).trim().split('\n')

    // Seven Python files, one process: a per-file design would cost 50-80 ms each
    // and turn a large repository into a minutes-long analysis.
    expect(index.modules).toHaveLength(7)
    expect(spawns).toHaveLength(1)
  })

  it('is not fooled by a fake interpreter that never answers, and reaps it', async () => {
    const root = await tempDir('anatomy-hang-')
    const logPath = path.join(root, 'spawn.log')
    // `cat` echoes the request and exits only on EOF: a sidecar that never speaks.
    const pythonPath = await fakePython('exec /bin/cat', logPath)

    const index = await indexOf(fixtureFiles(), { pythonPath, timeoutMs: 150 })
    const pid = Number.parseInt((await readFile(logPath, 'utf8')).trim(), 10)

    expect(index.notes).toEqual(['python indexer timed out after 150 ms'])
    expect(index.modules).toEqual([])
    // The child is terminated and reaped before the promise settles: a leaked
    // interpreter would outlive the run it was serving.
    expect(isAlive(pid)).toBe(false)
  })

  it('turns an interpreter that dies before answering into a note', async () => {
    const root = await tempDir('anatomy-exit-')
    const logPath = path.join(root, 'spawn.log')
    const pythonPath = await fakePython('exit 3', logPath)

    const index = await indexOf(fixtureFiles(), { pythonPath })
    const pid = Number.parseInt((await readFile(logPath, 'utf8')).trim(), 10)

    // A sidecar that cannot speak is a caveat about the structure graph, not a
    // reason to lose the rest of the analysis.
    expect(index).toEqual({
      modules: [],
      symbols: [],
      unresolved: 0,
      notes: ['python indexer exited unexpectedly (code 3)'],
    })
    expect(isAlive(pid)).toBe(false)
  })

  it('reports a missing interpreter instead of throwing', async () => {    const index = await indexOf(fixtureFiles(), { pythonPath: '/nonexistent/python3' })

    expect(index).toEqual({
      modules: [],
      symbols: [],
      unresolved: 0,
      notes: ['python3 not found; python files unanalyzed'],
    })
  })

  it('reports a non-executable interpreter override the same way', async () => {
    const root = await tempDir('anatomy-not-executable-')
    const pythonPath = path.join(root, 'python3')
    await writeFile(pythonPath, '#!/bin/sh\nexit 0\n')
    await chmod(pythonPath, 0o644)

    const index = await indexOf(fixtureFiles(), { pythonPath })

    expect(index.notes).toEqual(['python3 not found; python files unanalyzed'])
  })

  it('never spawns when the scope holds no Python', async () => {
    const root = await tempDir('anatomy-empty-')
    const logPath = path.join(root, 'spawn.log')
    const pythonPath = await fakePython(`exec python3 '${SIDECAR}'`, logPath)

    const repo = await repoOf({ 'src/index.ts': 'export const x = 1\n', 'a.rs': 'fn main() {}\n' })
    const index = await indexPython(repo, await selectScope(repo), { pythonPath })

    expect(index).toEqual({ modules: [], symbols: [], unresolved: 0, notes: [] })
    await expect(readFile(logPath, 'utf8')).rejects.toThrow()
  })

  it('resolves `from . import name` to the module the name imports', async () => {
    const index = await indexOf({
      'pkg/__init__.py': 'from . import x\n',
      'pkg/x.py': 'FLAG = True\n',
      'pkg/core.py': 'from . import util\nfrom .missing import gone\n',
      'pkg/util.py': 'def helper():\n    return 1\n',
      // An alias that names a package rather than a module.
      'pkg/deep/__init__.py': 'from . import sub\n',
      'pkg/deep/sub/__init__.py': 'FLAG = True\n',
    })

    // The alias is a member of the package: `from . import util` is `pkg/util.py`,
    // not the package `__init__`. Inside `pkg/__init__.py` the difference is a
    // self-edge — a module importing itself, which no reader can act on.
    expect(moduleAt(index, 'pkg/core.py').imports).toEqual([
      { from: 'pkg/core.py', specifier: '.', resolved: 'pkg/util.py' },
      { from: 'pkg/core.py', specifier: '.missing', resolved: null },
    ])
    expect(moduleAt(index, 'pkg/__init__.py').imports).toEqual([
      { from: 'pkg/__init__.py', specifier: '.', resolved: 'pkg/x.py' },
    ])
    // The same probe in package form: `<base>/<alias>/__init__.py`.
    expect(moduleAt(index, 'pkg/deep/__init__.py').imports).toEqual([
      { from: 'pkg/deep/__init__.py', specifier: '.', resolved: 'pkg/deep/sub/__init__.py' },
    ])
    // `from . import missing` names nothing on disk and is the only miss here.
    expect(index.unresolved).toBe(1)
  })

  it('never imports a stdlib module shadowed from the environment', async () => {
    const trap = await tempDir('anatomy-pythonpath-trap-')
    const marker = path.join(trap, 'pwned')
    // Anything on PYTHONPATH wins over the stdlib, so this file would run the
    // instant the sidecar imported `ast` — before it had read a single target.
    await writeFile(path.join(trap, 'ast.py'), `open(${JSON.stringify(marker)}, 'w').write('ran')\n`)

    const previous = process.env['PYTHONPATH']
    process.env['PYTHONPATH'] = trap
    let index: StructureIndex
    try {
      index = await indexOf(fixtureFiles())
    } finally {
      if (previous === undefined) delete process.env['PYTHONPATH']
      else process.env['PYTHONPATH'] = previous
    }

    // The headline invariant: reading a repository must never run code, including
    // code a poisoned environment smuggles into the reader's own interpreter.
    expect(existsSync(marker)).toBe(false)
    expect(index.modules).toHaveLength(7)
    expect(index.notes).toEqual(['parse errors in 1 files'])
  })

  it('speaks utf-8 to an interpreter whose locale codec is not', async () => {
    const root = await tempDir('anatomy-locale-')
    const logPath = path.join(root, 'spawn.log')
    // The interpreter is told to use latin-1 for its stdio, which is what
    // PYTHONIOENCODING in a user's environment can do without anyone noticing.
    const pythonPath = await fakePython(`PYTHONIOENCODING=latin-1 exec python3 '${SIDECAR}'`, logPath)

    const index = await indexOf({ 'caf\u00e9.py': 'VALUE = 1\n' }, { pythonPath, timeoutMs: 3000 })

    // The wire format is utf-8 by contract; a request path that is re-decoded
    // through another codec matches nothing and every reply is dropped.
    expect(index.modules).toEqual([{ path: 'caf\u00e9.py', imports: [] }])
    expect(spelled(index)).toEqual(['caf\u00e9.py:VALUE:const:1'])
    expect(index.notes).toEqual([])
  })

  it('keeps serving after a file raises during collection', async () => {
    const root = await tempDir('anatomy-collect-')
    const logPath = path.join(root, 'spawn.log')
    // A pathological target — two hundred nested tuple targets — parses in C but
    // walks off the end of the interpreter's stack in `collect`. The lowered limit
    // makes that reachable on a normal interpreter rather than needing megabytes
    // of input, and the walk is the thing under test.
    const pythonPath = await fakePython(
      `exec python3 -c 'import runpy, sys; sys.setrecursionlimit(120); ` +
        `runpy.run_path("${SIDECAR}", run_name="__main__")'`,
      logPath,
    )

    const index = await indexOf(
      {
        'a_nested.py': `x = 1\n${'('.repeat(200)}a${',)'.repeat(200)} = x\n`,
        'z_next.py': 'VALUE = 1\n',
      },
      { pythonPath },
    )

    // One unreadable file is a note; the batch, and the files after it, survive.
    expect(index.modules.map((module) => module.path)).toEqual(['a_nested.py', 'z_next.py'])
    expect(moduleAt(index, 'a_nested.py').imports).toEqual([])
    expect(spelled(index)).toEqual(['z_next.py:VALUE:const:1'])
    expect(index.notes).toEqual(['parse errors in 1 files'])
  })

  it('ships the sidecar next to the compiled client', async () => {
    const outDir = path.join(await tempDir('anatomy-build-'), 'dist')
    await mkdir(path.join(outDir, 'kernel/structure'), { recursive: true })
    await writeFile(path.join(outDir, 'kernel/structure/python.js'), '// compiled\n')

    execFileSync(process.execPath, [COPY_SIDECAR, outDir], { cwd: PACKAGE_ROOT, stdio: 'pipe' })

    // The module spawns `./python_index.py` relative to its own compiled location,
    // so a build that drops the script leaves every installed user with code 2 and
    // no Python structure at all.
    expect(await readFile(path.join(outDir, 'kernel/structure/python_index.py'), 'utf8')).toBe(
      await readFile(SIDECAR, 'utf8'),
    )
    // And the copy is part of `build`, not a step someone has to remember.
    const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['build']).toContain('copy-sidecar.mjs')
  })
})
