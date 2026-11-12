/**
 * Repository profile: the shape of what anatomy is about to read.
 *
 * The profile is the honest half of the report header. `manifests` and
 * `entryPoints` say where the project says it starts; `hasTests` / `hasCi` /
 * `hasDocs` say which kinds of evidence exist to be cited. Everything this
 * module could not work out ends up in `notes` — a dominant language it cannot
 * parse, an empty scope, a manifest it could not read. A caveat that is dropped
 * silently reads as a clean bill of health, so nothing here throws on bad input:
 * the analysis continues and the caveat travels with it.
 *
 * Nothing found in the repository is ever executed. `package.json` is JSON, and
 * `pyproject.toml` is read by a structure scan rather than a TOML parser, so a
 * `setup.py` or an npm lifecycle script is only ever bytes on disk.
 */

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Profile, Scope } from '../contracts/types.js'
import { canonicalizeFile } from './canonicalize.js'
import { detectLanguage } from './scope.js'

/** Exact filenames that make a directory a project root, matched at the analysis root and one level down. */
const MANIFEST_NAMES = ['Cargo.toml', 'go.mod', 'package.json', 'pyproject.toml', 'setup.py'] as const

/**
 * Directories whose manifests are never the project's own. Same structural
 * exclusion `selectScope` applies, for the same reason: a `package.json` inside
 * an installed dependency must not become the entry point of the analysis.
 */
const SKIPPED_MANIFEST_DIRS: ReadonlySet<string> = new Set([
  'build',
  'dist',
  'node_modules',
  'target',
  'third_party',
  'vendor',
])

/**
 * Extensions of languages anatomy cannot analyse, mapped to the name the report
 * prints. Only programming languages are listed: a repository that is mostly
 * Markdown, JSON or CSS has no unanalysed *language* to warn about, and saying
 * so would bury the caveat that matters — a tree that is mostly Rust cannot be
 * read at all.
 */
const UNSUPPORTED_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ['rs', 'rust'],
  ['c', 'c'],
  ['h', 'c'],
  ['cc', 'c++'],
  ['cpp', 'c++'],
  ['cxx', 'c++'],
  ['hpp', 'c++'],
  ['hh', 'c++'],
  ['m', 'objective-c'],
  ['mm', 'objective-c'],
  ['cs', 'c#'],
  ['fs', 'f#'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['go', 'go'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['swift', 'swift'],
  ['scala', 'scala'],
  ['clj', 'clojure'],
  ['ex', 'elixir'],
  ['exs', 'elixir'],
  ['erl', 'erlang'],
  ['hs', 'haskell'],
  ['ml', 'ocaml'],
  ['elm', 'elm'],
  ['lua', 'lua'],
  ['pl', 'perl'],
  ['r', 'r'],
  ['jl', 'julia'],
  ['dart', 'dart'],
  ['zig', 'zig'],
  ['nim', 'nim'],
  ['f90', 'fortran'],
  ['groovy', 'groovy'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
])

/** A language below this share of kept files is not worth a caveat. */
const UNANALYSED_LANGUAGE_THRESHOLD = 5

/** `src/index.*` is the convention every runtime here shares, checked in this order. */
const INDEX_FILES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.jsx',
  'src/index.mjs',
  'src/index.cjs',
  'src/index.py',
]

/** `__main__.py` at the root or inside one package directory (`python -m pkg`). */
const MAIN_MODULE = /^(?:[^/]+\/)?__main__\.py$/

/** A file sitting directly in the root `bin/` directory. */
const BIN_ENTRY = /^bin\/[^/]+$/

const TEST_FILE = /\.test\.|_test\./
const PY_TEST_FILE = /(?:^|\/)test_[^/]*\.py$/
const TESTS_DIR = /(?:^|\/)tests\//
const CI_FILES = ['.gitlab-ci.yml', 'azure-pipelines.yml', 'circle.yml'] as const
const CI_WORKFLOW_DIR = /^\.github\/workflows\//
const DOC_FILES = /(?:^|\/)readme\.(?:md|rst)$/i
const DOCS_DIR = /(?:^|\/)docs\//

// --- small filesystem helpers --------------------------------------------

async function isFile(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isDirectory()
  } catch {
    return false
  }
}

function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** One line, whatever the error was: a note is a line in a report header, not a stack trace. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim() || 'unreadable'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// --- manifests ------------------------------------------------------------

/**
 * Manifests at the root and in each immediate subdirectory, repo-relative and sorted.
 *
 * Depth is deliberately capped: in a monorepo the interesting manifests are the
 * workspace roots, and a full-tree search would surface every fixture package in
 * the repository. Dot-directories (`.github`, `.config`) hold tooling, not
 * project manifests, and symlinks are not followed.
 */
async function findManifests(rootAbs: string): Promise<string[]> {
  const found: string[] = []

  const consider = async (dirAbs: string, dirRel: string): Promise<void> => {
    for (const name of MANIFEST_NAMES) {
      if (await isFile(path.join(dirAbs, name))) found.push(dirRel === '' ? name : `${dirRel}/${name}`)
    }
  }

  await consider(rootAbs, '')

  let entries: Dirent[]
  try {
    entries = await readdir(rootAbs, { withFileTypes: true })
  } catch {
    // An unreadable root means no manifests to report; `selectScope` is where a
    // missing or unreadable root becomes an error, so this stays tolerant.
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.') || SKIPPED_MANIFEST_DIRS.has(entry.name)) continue
    await consider(path.join(rootAbs, entry.name), entry.name)
  }

  return found.sort()
}

/** Canonical text of a manifest, or a note when it cannot even be read. */
async function readManifestText(
  rootAbs: string,
  relative: string,
  notes: string[],
): Promise<string | null> {
  try {
    return (await canonicalizeFile(path.join(rootAbs, relative))).text
  } catch (error) {
    notes.push(`could not parse ${relative}: ${reasonOf(error)}`)
    return null
  }
}

/** `bin` and `main` of one `package.json`, as written (resolution happens later). */
async function packageEntryPoints(
  rootAbs: string,
  relative: string,
  notes: string[],
): Promise<string[]> {
  const text = await readManifestText(rootAbs, relative, notes)
  if (text === null) return []

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    notes.push(`could not parse ${relative}: ${reasonOf(error)}`)
    return []
  }
  if (!isRecord(value)) {
    notes.push(`could not parse ${relative}: top-level JSON value is not an object`)
    return []
  }

  const declared: string[] = []
  const bin = value['bin']
  if (typeof bin === 'string') {
    declared.push(bin)
  } else if (isRecord(bin)) {
    // Sorted so two runs over one tree always list the same declared order.
    for (const key of Object.keys(bin).sort()) {
      const target = bin[key]
      if (typeof target === 'string') declared.push(target)
    }
  }
  const main = value['main']
  if (typeof main === 'string') declared.push(main)

  return declared
}

/**
 * Script keys declared in `[project.scripts]` or `[tool.poetry.scripts]`.
 *
 * A TOML parser is not a dependency this project is willing to add for two table
 * lookups, so this is a *structure* scan, not a TOML implementation. It tracks
 * bracket depth and quotes well enough to skip over multi-line arrays, inline
 * tables and triple-quoted strings, which is where a line-by-line regex would
 * report false failures. Limits, deliberately:
 *
 * - It reads section names and key names only. It never interprets values, so
 *   resolving `"widget.cli:main"` to `widget/cli.py` is out of scope.
 * - TOML that is genuinely malformed is caught only where the shape is
 *   unambiguous: a table header without its closing bracket, an unterminated
 *   single-line string, or a top-level line that is neither `key = value` nor a
 *   `[table]`. Anything subtler passes silently, and the note is then simply
 *   absent rather than wrong.
 */
function scanPyprojectScripts(text: string): string[] {
  const SCRIPT_SECTIONS: ReadonlySet<string> = new Set(['project.scripts', 'tool.poetry.scripts'])
  const TABLE = /^\[\[?\s*(.+?)\s*\]\]?$/
  const KEY_LINE = /^(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=/

  const scripts: string[] = []
  let section = ''
  let depth = 0
  let quote: string | null = null

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1

    // A line that begins while a value is still open is a continuation of that
    // value, not a new statement.
    if (depth === 0 && quote === null) {
      const statement = line.trim()
      if (statement !== '' && !statement.startsWith('#')) {
        if (statement.startsWith('[')) {
          const table = TABLE.exec(statement)
          if (table === null) throw new Error(`line ${lineNumber}: unterminated table header`)
          section = table[1] ?? ''
        } else if (!KEY_LINE.test(statement)) {
          throw new Error(`line ${lineNumber}: not a "key = value" or "[table]" line`)
        } else if (SCRIPT_SECTIONS.has(section)) {
          const key = statement.slice(0, statement.indexOf('=')).trim().replace(/^["']|["']$/g, '')
          scripts.push(key)
        }
      }
    }

    for (let position = 0; position < line.length; position += 1) {
      const char = line[position] as string
      if (quote !== null) {
        if (quote.length === 3) {
          if (line.startsWith(quote, position)) {
            quote = null
            position += 2
          }
          continue
        }
        if (char === '\\' && quote === '"') {
          position += 1
          continue
        }
        if (char === quote) quote = null
        continue
      }
      if (char === '#') break
      if (char === '"' || char === "'") {
        const triple = line.slice(position, position + 3)
        if (triple === '"""' || triple === "'''") {
          quote = triple
          position += 2
          continue
        }
        quote = char
        continue
      }
      if (char === '[' || char === '{') depth += 1
      else if (char === ']' || char === '}') depth = depth > 0 ? depth - 1 : 0
    }

    if (quote !== null && quote.length === 1) {
      throw new Error(`line ${lineNumber}: unterminated string`)
    }
  }

  return scripts
}

async function pyprojectDeclaresScripts(
  rootAbs: string,
  relative: string,
  notes: string[],
): Promise<boolean> {
  const text = await readManifestText(rootAbs, relative, notes)
  if (text === null) return false
  try {
    return scanPyprojectScripts(text).length > 0
  } catch (error) {
    notes.push(`could not parse ${relative}: ${reasonOf(error)}`)
    return false
  }
}

// --- derived facts --------------------------------------------------------

/**
 * One note per language that is present in bulk but cannot be parsed.
 *
 * The share is computed over every kept file, so it answers "how much of what we
 * are reading can we not read". Decimal percentages are rounded for the header;
 * the 5% floor is applied to the exact share.
 */
function unanalysedLanguageNotes(scope: Scope): string[] {
  const total = scope.files.length
  if (total === 0) return []

  const counts = new Map<string, number>()
  for (const file of scope.files) {
    // `ScopeFile.language` is derived from the same extension, but asking
    // `detectLanguage` keeps this module honest if a Scope arrives from elsewhere.
    if (detectLanguage(file.path) !== null) continue
    const name = UNSUPPORTED_LANGUAGES.get(extensionOf(file.path))
    if (name === undefined) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, share: (count / total) * 100 }))
    .filter((entry) => entry.share >= UNANALYSED_LANGUAGE_THRESHOLD)
    .sort((a, b) => (a.share === b.share ? (a.name < b.name ? -1 : 1) : b.share - a.share))
    .map((entry) => `unanalysed language: ${entry.name} (${Math.round(entry.share)}%)`)
}

/**
 * A declared entry is only an entry point of *this* analysis if it survived the
 * scope: `bin` pointing at `dist/cli.js` names a file the report will never
 * quote, and a `main` that does not exist names nothing at all.
 */
function normalizeEntryPoint(declared: string, directory: string): string | null {
  const cleaned = declared.trim().replace(/^\.\//, '')
  if (cleaned === '' || path.isAbsolute(cleaned) || cleaned.split('/').includes('..')) return null
  return directory === '' ? cleaned : `${directory}/${cleaned}`
}

// --- the profile ----------------------------------------------------------

/**
 * Profiles `root`, using `scope` as the definition of what is being analysed.
 *
 * `scope` decides membership (an entry point must be a kept file); `root` is only
 * read for the metadata that the scope does not carry, namely manifest bytes.
 */
export async function profileRepo(root: string, scope: Scope): Promise<Profile> {
  const rootAbs = path.resolve(root)
  const kept = new Set(scope.files.map((file) => file.path))
  const notes: string[] = []
  const entryPoints: string[] = []

  if (scope.files.length === 0) notes.push('no analysable files found')
  notes.push(...unanalysedLanguageNotes(scope))

  // Insertion order is the order the report presents: what the project declares
  // first, then the conventions on disk. Duplicates keep their first position.
  const addEntry = (candidate: string): void => {
    if (!kept.has(candidate) || entryPoints.includes(candidate)) return
    entryPoints.push(candidate)
  }

  const manifests = await findManifests(rootAbs)

  for (const manifest of manifests) {
    const base = path.posix.basename(manifest)
    const dirname = path.posix.dirname(manifest)
    const directory = dirname === '.' ? '' : dirname
    if (base === 'package.json') {
      for (const declared of await packageEntryPoints(rootAbs, manifest, notes)) {
        const resolved = normalizeEntryPoint(declared, directory)
        if (resolved !== null) addEntry(resolved)
      }
    } else if (base === 'pyproject.toml') {
      // Script values are `module:callable` strings; mapping those to files is a
      // resolver question, not a manifest question, so the manifest itself is
      // what gets recorded. Only when it actually declares a script, so a plain
      // library does not show up as its own entry point.
      if (await pyprojectDeclaresScripts(rootAbs, manifest, notes)) addEntry(manifest)
    }
  }

  for (const candidate of INDEX_FILES) addEntry(candidate)

  const sortedKept = [...kept].sort()
  for (const candidate of sortedKept) if (MAIN_MODULE.test(candidate)) addEntry(candidate)
  for (const candidate of sortedKept) if (BIN_ENTRY.test(candidate)) addEntry(candidate)

  const hasTests =
    sortedKept.some((file) => TEST_FILE.test(file) || PY_TEST_FILE.test(file) || TESTS_DIR.test(file)) ||
    (await isDirectory(path.join(rootAbs, 'tests')))

  const hasCi =
    sortedKept.some((file) => CI_WORKFLOW_DIR.test(file)) ||
    (await isDirectory(path.join(rootAbs, '.github', 'workflows'))) ||
    (await Promise.all(CI_FILES.map((name) => isFile(path.join(rootAbs, name))))).includes(true)

  const hasDocs =
    sortedKept.some((file) => DOC_FILES.test(file) || DOCS_DIR.test(file)) ||
    (await isDirectory(path.join(rootAbs, 'docs')))

  return {
    languages: { ...scope.byLanguage },
    manifests,
    entryPoints,
    hasTests,
    hasCi,
    hasDocs,
    notes,
  }
}
