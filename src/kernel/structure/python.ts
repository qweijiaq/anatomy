/**
 * Structure of Python: which module imports which, and what each module declares.
 *
 * Two decisions shape this module.
 *
 * 1. **Nothing in the analysed repository is executed.** The parse happens in
 *    `python_index.py` and only ever through `ast.parse`; no `compile`, no
 *    `exec`, no `import`. A repository is data to be read, never a program to be
 *    trusted with the analysis it is the subject of.
 * 2. **One interpreter for the whole run.** Startup costs 50-80 ms, which is
 *    invisible for one file and turns a 5 000-file tree into minutes. So the child
 *    is spawned once, fed a batch of paths over NDJSON, and asked to exit. The
 *    protocol lives in the sidecar's docstring; this module is its client, and the
 *    only thing it trusts is that a reply line is JSON with a `path`.
 *
 * Resolution is hand-rolled against the *scope's* kept path set, not the
 * filesystem, so a `resolved` edge is a promise that an indexed module exists —
 * the same contract `ts.ts` keeps. An absolute import is not a failure (it names
 * a package the analysis cannot see), so only a relative import that lands on
 * nothing increments `unresolved`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ImportEdge,
  ModuleNode,
  Scope,
  StructureIndex,
  SymbolKind,
  SymbolRef,
} from '../../contracts/types.js'
import { detectLanguage } from '../scope.js'

/** A hung sidecar must become a caveat, not a run that never ends. */
const DEFAULT_TIMEOUT_MS = 30_000

/** How long a polite `exit` gets before the child is killed. */
const EXIT_GRACE_MS = 1_000

/** The sidecar script, resolved next to this module so an untranspiled checkout works. */
const SIDECAR_SCRIPT = fileURLToPath(new URL('./python_index.py', import.meta.url))

/**
 * The answer when there is no interpreter to run. One caveat and no structure:
 * a guessed index would be indistinguishable from a read one.
 */
function notFound(): StructureIndex {
  return {
    modules: [],
    symbols: [],
    unresolved: 0,
    notes: ['python3 not found; python files unanalyzed'],
  }
}

const SYMBOL_KINDS: ReadonlySet<string> = new Set<SymbolKind>(['function', 'class', 'const'])

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export type PythonIndexOptions = {
  /** Interpreter to run the sidecar with; defaults to `python3` on `PATH`. */
  pythonPath?: string
  /** Time allowed for one batch, after which the sidecar is killed and noted. */
  timeoutMs?: number
}

// --- live children --------------------------------------------------------

/**
 * Children that are still running. A signal-safe registry is not enough on its
 * own — `exit` cannot await — so the hook does the one thing that is legal there,
 * a synchronous `SIGKILL`. Every ordinary path reaps its own child in
 * `stopSidecar`, before the promise settles; this is the backstop for a run that
 * is interrupted mid-batch.
 */
const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false

function trackChild(child: ChildProcess): void {
  liveChildren.add(child)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const live of liveChildren) live.kill('SIGKILL')
  })
}

/**
 * Terminate and reap one child.
 *
 * The sidecar's contract is a single `exit` line, so it is asked first: a child
 * that answers has flushed every reply and exits on its own. A child that does
 * not — one that is wedged, or that never understood the protocol — is killed
 * after a grace period. Either way this resolves only once the child is gone, so
 * no caller can return with an interpreter still attached to it.
 */
async function stopSidecar(child: ChildProcess): Promise<void> {
  const dead = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (dead()) {
    liveChildren.delete(child)
    return
  }

  const exited = new Promise<void>((resolve) => {
    let done = false
    const settle = (): void => {
      if (done) return
      done = true
      resolve()
    }
    if (dead()) {
      settle()
      return
    }
    child.once('exit', settle)
    // A child that never spawned emits no `exit` at all — only `error` and then
    // `close` — and waiting for an event that will not come is how a run hangs on
    // the one path that was supposed to be the safe one.
    child.once('close', settle)
  })

  const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS)
  try {
    // Ending stdin is the polite half: it asks for the exit line *and* closes the
    // pipe, so a child that ignores the protocol still sees EOF.
    child.stdin?.end('{"type":"exit"}\n')
  } catch {
    child.kill('SIGKILL')
  }

  await exited
  clearTimeout(timer)
  liveChildren.delete(child)
}

// --- protocol -------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type Reply = {
  path: string
  imports: unknown[]
  symbols: unknown[]
  error: string | null
}

type Batch =
  | { outcome: 'replies'; replies: Map<string, Reply> }
  | { outcome: 'missing' }
  | { outcome: 'timeout'; replies: Map<string, Reply> }
  | { outcome: 'closed'; code: number | null; replies: Map<string, Reply> }

/**
 * One reply line, or `null` for anything that is not one.
 *
 * The child is this project's own script, but the boundary is a pipe: a stray
 * line — a warning on stdout, an echoed request from a misconfigured interpreter —
 * must be ignored rather than trusted into the index.
 */
function parseReply(line: string): Reply | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value['path'] !== 'string') return null
  return {
    path: value['path'],
    imports: Array.isArray(value['imports']) ? value['imports'] : [],
    symbols: Array.isArray(value['symbols']) ? value['symbols'] : [],
    error: typeof value['error'] === 'string' ? value['error'] : null,
  }
}

/**
 * Spawns the sidecar, asks it to index `files`, and waits for one reply per file.
 *
 * The three endings that are not success are all *data*, never exceptions: a
 * missing interpreter, a batch that overran its timeout, and a child that died
 * early. The caller turns each into a note, because a caveat that crashes the run
 * is indistinguishable from a crash.
 */
async function runBatch(
  pythonPath: string,
  files: string[],
  timeoutMs: number,
): Promise<Batch> {
  let child: ChildProcess
  try {
    child = spawn(pythonPath, [SIDECAR_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return { outcome: 'missing' }
  }

  trackChild(child)
  try {
    return await new Promise<Batch>((resolve) => {
      const wanted = new Set(files)
      const replies = new Map<string, Reply>()
      let settled = false

      const finish = (batch: Batch): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(batch)
      }

      const timer = setTimeout(() => finish({ outcome: 'timeout', replies }), timeoutMs)

      child.once('error', (error: NodeJS.ErrnoException) => {
        // No interpreter, or one that cannot be executed: ENOENT and EACCES are
        // the two ways a `pythonPath` can be wrong.
        finish(
          error.code === 'ENOENT' || error.code === 'EACCES'
            ? { outcome: 'missing' }
            : { outcome: 'closed', code: null, replies },
        )
      })
      // A child that never starts makes every write fail with EPIPE; the failure is
      // already reported through `error` above.
      child.stdin?.on('error', () => {})
      // Unread stderr would eventually fill its pipe and wedge the child.
      child.stderr?.resume()

      let buffered = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          const reply = parseReply(buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          if (reply !== null && wanted.has(reply.path) && !replies.has(reply.path)) {
            replies.set(reply.path, reply)
          }
          newline = buffered.indexOf('\n')
        }
        if (replies.size === wanted.size) finish({ outcome: 'replies', replies })
      })

      child.once('exit', (code) => finish({ outcome: 'closed', code, replies }))

      try {
        child.stdin?.write(`${JSON.stringify({ type: 'index', files })}\n`)
      } catch {
        finish({ outcome: 'closed', code: null, replies })
      }
    })
  } finally {
    // Every path — success, timeout, early exit, a throw above — ends here.
    await stopSidecar(child)
  }
}

// --- resolution -----------------------------------------------------------

/**
 * The kept file a relative import names, or `null`.
 *
 * Level 1 is the importing file's own directory (`from . import x`), so each extra
 * dot climbs one directory; a climb above the analysed root names a file the
 * reader will never see and is not followed. The module path is then probed as a
 * module and as a package, which is exactly how Python itself finds them.
 */
function resolveRelativePython(
  level: number,
  module: string,
  fromPath: string,
  kept: ReadonlySet<string>,
): string | null {
  const directory = path.posix.dirname(fromPath)
  let base = directory === '.' ? '' : directory
  for (let step = 1; step < level; step += 1) {
    if (base === '') return null
    const parent = path.posix.dirname(base)
    base = parent === '.' ? '' : parent
  }

  const dotted = module.split('.').filter((part) => part !== '').join('/')
  const relative = dotted === '' ? base : base === '' ? dotted : `${base}/${dotted}`
  const candidates =
    relative === '' ? ['__init__.py'] : [`${relative}.py`, `${relative}/__init__.py`]
  for (const candidate of candidates) {
    if (kept.has(candidate)) return candidate
  }
  return null
}

// --- the index ------------------------------------------------------------

/**
 * Indexes every Python file in `scope` under `root`.
 *
 * Structure only: modules with their edges, and top-level declarations. A file
 * that does not parse still becomes a module — it exists in the tree, and dropping
 * it would leave every edge into it dangling — and the failure is reported once, in
 * `notes`, because a caveat must travel with the findings it qualifies.
 */
export async function indexPython(
  root: string,
  scope: Scope,
  options: PythonIndexOptions = {},
): Promise<StructureIndex> {
  const rootAbs = path.resolve(root)
  const pythonFiles = scope.files
    .map((file) => file.path)
    .filter((file) => detectLanguage(file) === 'py')
    .sort(byCodeUnit)

  // No Python in scope is not a caveat: nothing was missed, nothing was attempted.
  if (pythonFiles.length === 0) return { modules: [], symbols: [], unresolved: 0, notes: [] }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const batch = await runBatch(
    options.pythonPath ?? 'python3',
    pythonFiles.map((file) => path.join(rootAbs, file)),
    timeoutMs,
  )
  if (batch.outcome === 'missing') return notFound()

  // A partial batch is still reported: the replies that did arrive are real, and
  // the note says which part of the tree they came from.
  const notes: string[] = []
  if (batch.outcome === 'timeout') notes.push(`python indexer timed out after ${timeoutMs} ms`)
  if (batch.outcome === 'closed') {
    notes.push(
      batch.code === null
        ? 'python indexer exited unexpectedly'
        : `python indexer exited unexpectedly (code ${batch.code})`,
    )
  }

  const kept = new Set(pythonFiles)
  const modules: ModuleNode[] = []
  const symbols: SymbolRef[] = []
  const pending: Array<{ edge: ImportEdge; level: number }> = []
  let parseErrors = 0
  let unresolved = 0

  for (const file of pythonFiles) {
    // The child is sent absolute paths; the index is written in scope paths.
    const reply = batch.replies.get(path.join(rootAbs, file))
    if (reply === undefined) continue
    if (reply.error !== null) parseErrors += 1

    const seen = new Set<string>()
    const imports: ImportEdge[] = []
    if (reply.error === null) {
      for (const entry of reply.imports) {
        if (!isRecord(entry)) continue
        const specifier = entry['specifier']
        if (typeof specifier !== 'string') continue
        if (seen.has(specifier)) continue
        seen.add(specifier)
        const rawLevel = entry['level']
        const level =
          typeof rawLevel === 'number' && Number.isInteger(rawLevel) && rawLevel >= 0 ? rawLevel : 0
        const edge: ImportEdge = { from: file, specifier, resolved: null }
        imports.push(edge)
        pending.push({ edge, level })
      }

      for (const entry of reply.symbols) {
        if (!isRecord(entry)) continue
        const name = entry['name']
        const kind = entry['kind']
        const line = entry['line']
        if (typeof name !== 'string' || typeof kind !== 'string' || !SYMBOL_KINDS.has(kind)) continue
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue
        symbols.push({ name, kind: kind as SymbolKind, path: file, line })
      }
    }

    modules.push({ path: file, imports })
  }

  // Edges are resolved once every module is known, because `resolved` means "this
  // path is in the index": a relative import that lands on a file this batch never
  // reached is left null rather than promising a node that is not there.
  const emitted = new Set(modules.map((module) => module.path))
  for (const { edge, level } of pending) {
    if (level === 0) continue
    const target = resolveRelativePython(level, edge.specifier.slice(level), edge.from, kept)
    if (target === null) {
      unresolved += 1
    } else if (emitted.has(target)) {
      edge.resolved = target
    }
  }

  if (parseErrors > 0) notes.push(`parse errors in ${parseErrors} files`)

  modules.sort((a, b) => byCodeUnit(a.path, b.path))
  symbols.sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line || byCodeUnit(a.name, b.name))

  return { modules, symbols, unresolved, notes }
}
