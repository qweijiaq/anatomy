/**
 * Analysis scope: which files in a repository are "the project".
 *
 * Two failure modes motivate this module.
 *
 * 1. Vendored or generated code scoring as the project's own design. A copy of
 *    React under `vendor/` must never become a learning point, so such trees are
 *    excluded structurally, not by heuristic.
 * 2. A large monorepo being rejected outright because of fixture noise. Limits
 *    only mean something once exclusions have been applied, so every counter
 *    here is incremented *after* exclusion and every exclusion is reported with
 *    a count. Limits fail fast: the walk throws as soon as a dimension is
 *    exceeded instead of finishing a full traversal first.
 *
 * `.gitignore` is honoured per directory, resolved relative to the directory
 * that holds the file, because the alternative — a repo-wide matcher applied to
 * root-relative paths — silently drops real source files when a nested ignore
 * file uses an anchored pattern.
 */

import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type {
  Scope,
  ScopeExclusionReason,
  ScopeFile,
  ScopeLimits,
  ScopeOptions,
} from '../contracts/types.js'
import { DEFAULT_LIMITS } from '../contracts/types.js'

export type ScopeLimitDimension = 'bytes' | 'files' | 'lines'

export class ScopeLimitError extends Error {
  readonly dimension: ScopeLimitDimension
  readonly actual: number
  readonly limit: number

  constructor(dimension: ScopeLimitDimension, actual: number, limit: number) {
    super(`anatomy: analysis scope exceeds the ${dimension} limit (${actual} > ${limit})`)
    this.name = 'ScopeLimitError'
    this.dimension = dimension
    this.actual = actual
    this.limit = limit
  }
}

/** Reported in this order; a file is counted once, under the first reason that matches. */
const REASON_ORDER: readonly ScopeExclusionReason[] = [
  'gitignore',
  'vendored',
  'vcs',
  'generated',
  'minified',
  'lockfile',
  'binary',
  'large-fixture',
]

/**
 * Hardcoded directory reasons, by name at any depth. `.git` is bookkeeping rather
 * than project source; there is no dedicated reason in the contract, so it
 * travels with `vendored` (third-party-managed data, never the project's own
 * design). `target`, `__pycache__` and `coverage` are build/test output exactly
 * like `dist`; `.venv` is an installed dependency tree exactly like `vendor`.
 */
const DIRECTORY_REASONS: ReadonlyMap<string, ScopeExclusionReason> = new Map([
  ['vendor', 'vendored'],
  ['third_party', 'vendored'],
  ['node_modules', 'vendored'],
  ['.venv', 'vendored'],
  // Reported as its own reason: calling `.git` vendored tells the reader the
  // project contains third-party code it does not.
  ['.git', 'vcs'],
  ['dist', 'generated'],
  ['build', 'generated'],
  ['target', 'generated'],
  ['__pycache__', 'generated'],
  ['coverage', 'generated'],
])

/**
 * Every directory anatomy never reads, by name at any depth.
 *
 * One list, imported by `selectScope`, `hashTree` and `profileRepo`. The three
 * used to keep their own copies, and they disagreed: the tree digest ignored
 * `target` only accidentally, so a `cargo build` moved the `sha` and minted a new
 * `runId` for input whose analysed content was byte-identical.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(DIRECTORY_REASONS.keys())

const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
])

const MINIFIED = /\.min\.[^/]+$/
const FIXTURE_SEGMENT = /(?:^|\/)fixtures?(?:\/|$)/
const LARGE_FIXTURE_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024

const EXTENSION_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ['ts', 'ts'],
  ['tsx', 'tsx'],
  ['js', 'js'],
  ['jsx', 'jsx'],
  ['mjs', 'mjs'],
  ['cjs', 'cjs'],
  ['py', 'py'],
])

/** Extension mapping for the languages this product actually reasons about. */
export function detectLanguage(filePath: string): string | null {
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSION_LANGUAGES.get(base.slice(dot + 1).toLowerCase()) ?? null
}

// --- gitignore matching ---------------------------------------------------

/**
 * One parsed `.gitignore` line. `base` is the posix directory (relative to the
 * walk root) whose `.gitignore` produced the rule, so patterns resolve against
 * that directory instead of against the root.
 */
type IgnoreRule = {
  negate: boolean
  dirOnly: boolean
  re: RegExp
  base: string
}

/**
 * Translates a gitignore glob to a regex body. `*` stops at `/`, `**` does not.
 *
 * Not supported, deliberately — this is a hand-written subset, not git's matcher:
 *
 * - `[...]` character classes are escaped literally, so `[Bb]in/` never matches.
 * - `.git/info/exclude` and `core.excludesFile` (global) excludes are never read;
 *   only `.gitignore` files are.
 * - A `!` negation cannot re-include a file below a pruned directory, and escaped
 *   spaces/backslashes mid-pattern are not interpreted.
 *
 * Every gap points the same way: a pattern we fail to understand matches less than
 * git would, so the file is *kept*. Over-inclusion costs a little budget and the
 * reader sees a file they might have skipped; silently dropping real source would
 * hide the project's own design, which is the failure mode this module exists to
 * prevent.
 */
function globToRegex(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]!
    if (char === '*') {
      let end = i
      while (pattern[end] === '*') end += 1
      const stars = end - i
      const next = pattern[end]
      if (stars >= 2 && next === '/') {
        // `**/` matches zero or more leading directories.
        out += '(?:[^/]+/)*'
        i = end + 1
      } else if (stars >= 2) {
        out += '.*'
        i = end
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (char === '?') {
      out += '[^/]'
      i += 1
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`
      i += 1
    } else {
      out += char
      i += 1
    }
  }
  return out
}

function compileRule(line: string, base: string): IgnoreRule | null {
  let pattern = line.replace(/(?<!\\)\s+$/, '')
  if (pattern === '' || pattern.startsWith('#')) return null

  let negate = false
  if (pattern.startsWith('!')) {
    negate = true
    pattern = pattern.slice(1)
  } else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
    pattern = pattern.slice(1)
  }

  let dirOnly = false
  if (pattern.endsWith('/')) {
    dirOnly = true
    pattern = pattern.replace(/\/+$/, '')
  }

  // Anchoring is decided *before* leading slashes are stripped: git treats a leading
  // `/` exactly like an inner one — the pattern is pinned to the directory of the
  // ignore file. Stripping first would turn `/lib` into the bare name `lib`, which
  // matches at any depth and silently prunes `src/lib/`.
  const anchored = pattern.startsWith('/') || pattern.includes('/')
  pattern = pattern.replace(/^\/+/, '')
  if (pattern === '') return null

  const body = globToRegex(pattern)
  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`

  try {
    return { negate, dirOnly, re: new RegExp(source), base }
  } catch {
    return null
  }
}

async function readIgnoreFile(dirAbs: string, base: string): Promise<IgnoreRule[]> {
  let text: string
  try {
    text = await readFile(path.join(dirAbs, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  const rules: IgnoreRule[] = []
  for (const line of text.split(/\r?\n/)) {
    const rule = compileRule(line, base)
    if (rule) rules.push(rule)
  }
  return rules
}

/**
 * One rule applied to one path. `base` scopes the pattern to the directory that owns
 * it; a rule from an outer directory does not see paths outside its own subtree.
 */
function matches(rule: IgnoreRule, relPath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  const scoped =
    rule.base === ''
      ? relPath
      : relPath.startsWith(`${rule.base}/`)
        ? relPath.slice(rule.base.length + 1)
        : null
  if (scoped === null) return false
  return rule.re.test(scoped)
}

/**
 * Last matching rule wins, which is what git does inside one file.
 *
 * `rules` are the `.gitignore` rules in parent-first order; `extras` are the caller's
 * `extraIgnore` patterns and are evaluated last, so an explicit exclusion beats any
 * `.gitignore` negation — including one from a nested file.
 *
 * Known simplification: directories are pruned when ignored, so a negation cannot
 * re-include a file below an ignored directory. Git behaves the same way unless the
 * parent directory itself is un-ignored first.
 */
function isIgnored(
  relPath: string,
  isDir: boolean,
  rules: readonly IgnoreRule[],
  extras: readonly IgnoreRule[],
): boolean {
  let ignored = false
  for (const rule of rules) {
    if (matches(rule, relPath, isDir)) ignored = !rule.negate
  }
  for (const rule of extras) {
    if (matches(rule, relPath, isDir)) ignored = !rule.negate
  }
  return ignored
}

// --- file probing ---------------------------------------------------------

async function readHead(absPath: string, limit: number): Promise<Buffer> {
  const handle = await open(absPath, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Counts lines without holding the file in memory. Terminators are `\n` and
 * lone `\r` (the canonicalizer normalizes CRLF/CR to LF first), so the number
 * matches `canonicalizeFile().lineCount`: a trailing terminator adds no line and
 * an empty file has 0 lines.
 */
async function countLines(absPath: string): Promise<number> {
  let terminators = 0
  let lastWasTerminator = false
  let sawAny = false
  let pendingCR = false

  const stream = createReadStream(absPath)
  for await (const chunk of stream) {
    const buffer = chunk as Buffer
    for (let i = 0; i < buffer.length; i += 1) {
      const byte = buffer[i]!
      sawAny = true
      if (pendingCR) {
        pendingCR = false
        terminators += 1
        lastWasTerminator = true
        if (byte === 0x0a) continue
      }
      lastWasTerminator = false
      if (byte === 0x0d) pendingCR = true
      else if (byte === 0x0a) {
        terminators += 1
        lastWasTerminator = true
      }
    }
  }

  if (pendingCR) {
    terminators += 1
    lastWasTerminator = true
  }
  if (!sawAny) return 0
  return lastWasTerminator ? terminators : terminators + 1
}

// --- selection ------------------------------------------------------------

class Collectors {
  readonly files: ScopeFile[] = []
  readonly excluded = new Map<ScopeExclusionReason, number>()
  readonly totals = { files: 0, bytes: 0, lines: 0 }
  readonly byLanguage: Record<string, number> = {}

  exclude(reason: ScopeExclusionReason): void {
    this.excluded.set(reason, (this.excluded.get(reason) ?? 0) + 1)
  }

  add(file: ScopeFile): void {
    this.files.push(file)
    this.totals.files += 1
    this.totals.bytes += file.bytes
    this.totals.lines += file.lines
    if (file.language !== null) {
      this.byLanguage[file.language] = (this.byLanguage[file.language] ?? 0) + 1
    }
  }
}

/** Whether `absPath` is inside `rootAbs` (root itself counts as inside). */
function isInsideRoot(rootAbs: string, absPath: string): boolean {
  const rel = path.relative(rootAbs, absPath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Walks the repository once, applying exclusions before counting, and stops at
 * the first limit breach.
 */
export async function selectScope(root: string, opts: ScopeOptions = {}): Promise<Scope> {
  const rootAbs = path.resolve(root)
  const limits: ScopeLimits = { ...DEFAULT_LIMITS, ...opts.limits }
  const startAbs = opts.subpath ? path.resolve(rootAbs, opts.subpath) : rootAbs

  // A typo'd checkout, a file path, or an unreadable directory must not look like an
  // empty repository: `{ files: [], excluded: [] }` reads as "nothing to analyse" and
  // would be reported as a successful, empty scope.
  let rootStat
  try {
    rootStat = await stat(rootAbs)
  } catch {
    throw new Error(`anatomy: root "${rootAbs}" does not exist`)
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`anatomy: root "${rootAbs}" is not a directory`)
  }

  if (opts.subpath !== undefined) {
    if (!isInsideRoot(rootAbs, startAbs)) {
      throw new Error(`anatomy: subpath "${opts.subpath}" escapes the repository root`)
    }
    let startStat
    try {
      startStat = await stat(startAbs)
    } catch {
      throw new Error(`anatomy: subpath "${opts.subpath}" does not exist in ${rootAbs}`)
    }
    if (!startStat.isDirectory()) {
      throw new Error(`anatomy: subpath "${opts.subpath}" is not a directory`)
    }
  }

  // Extra patterns behave like another .gitignore at the repository root, but they are
  // kept in a separate list evaluated after every .gitignore (see `isIgnored`), so an
  // explicit user exclusion beats a negation from any ignore file, nested included.
  const extraRules = (opts.extraIgnore ?? [])
    .map((pattern) => compileRule(pattern, ''))
    .filter((rule): rule is IgnoreRule => rule !== null)

  const collectors = new Collectors()

  // Ignore files from the root down to the start directory still apply, each
  // resolved against the directory that owns it.
  let inherited: IgnoreRule[] = await readIgnoreFile(rootAbs, '')
  const startRel = toPosix(path.relative(rootAbs, startAbs))
  if (startRel !== '') {
    let currentAbs = rootAbs
    let currentRel = ''
    for (const segment of startRel.split('/')) {
      currentAbs = path.join(currentAbs, segment)
      currentRel = currentRel === '' ? segment : `${currentRel}/${segment}`
      inherited = [...inherited, ...(await readIgnoreFile(currentAbs, currentRel))]
    }
  }

  const walk = async (dirAbs: string, dirRel: string, rules: IgnoreRule[]): Promise<void> => {
    let entries
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch (error) {
      // A directory that vanished between listing and reading is simply gone. Anything
      // else (EACCES, EMFILE, ...) would delete a whole subtree from the scope without
      // a count, so it has to surface instead of being read as an empty directory.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      // Symlinks are never followed: they can leave the repository or loop.
      if (entry.isSymbolicLink()) continue

      const entryAbs = path.join(dirAbs, entry.name)
      const entryRel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`

      if (entry.isDirectory()) {
        if (isIgnored(entryRel, true, rules, extraRules)) {
          collectors.exclude('gitignore')
          continue
        }
        const reason = DIRECTORY_REASONS.get(entry.name)
        if (reason) {
          collectors.exclude(reason)
          continue
        }
        const childRules = [...rules, ...(await readIgnoreFile(entryAbs, entryRel))]
        await walk(entryAbs, entryRel, childRules)
        continue
      }

      if (!entry.isFile()) continue

      if (isIgnored(entryRel, false, rules, extraRules)) {
        collectors.exclude('gitignore')
        continue
      }
      if (MINIFIED.test(entry.name)) {
        collectors.exclude('minified')
        continue
      }
      if (LOCKFILES.has(entry.name)) {
        collectors.exclude('lockfile')
        continue
      }

      let size: number
      let head: Buffer
      try {
        size = (await stat(entryAbs)).size
        head = await readHead(entryAbs, Math.min(BINARY_SNIFF_BYTES, Math.max(size, 1)))
      } catch {
        // Vanished or unreadable: not analysable, and no reason code fits.
        continue
      }

      if (head.includes(0)) {
        collectors.exclude('binary')
        continue
      }
      if (size > LARGE_FIXTURE_BYTES && FIXTURE_SEGMENT.test(entryRel)) {
        collectors.exclude('large-fixture')
        continue
      }

      if (collectors.totals.files + 1 > limits.maxFiles) {
        throw new ScopeLimitError('files', collectors.totals.files + 1, limits.maxFiles)
      }
      if (collectors.totals.bytes + size > limits.maxBytes) {
        throw new ScopeLimitError('bytes', collectors.totals.bytes + size, limits.maxBytes)
      }

      const lines = await countLines(entryAbs)
      if (collectors.totals.lines + lines > limits.maxLines) {
        throw new ScopeLimitError('lines', collectors.totals.lines + lines, limits.maxLines)
      }

      collectors.add({
        path: entryRel,
        bytes: size,
        lines,
        language: detectLanguage(entryRel),
      })
    }
  }

  await walk(startAbs, startRel, inherited)

  const excluded = REASON_ORDER.map((reason) => ({
    reason,
    count: collectors.excluded.get(reason) ?? 0,
  })).filter((entry) => entry.count > 0)

  return {
    root: rootAbs,
    files: collectors.files,
    excluded,
    totals: { ...collectors.totals },
    byLanguage: collectors.byLanguage,
  }
}
