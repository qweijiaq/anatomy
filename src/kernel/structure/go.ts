/**
 * Structure of Go: packages, imports and declarations.
 *
 * Go is already read by the generic declaration pass, which finds `func` and
 * `type` lines but claims no imports. This pass adds the part that makes a Go
 * repository legible: the import list (resolved against the checkout when the
 * module path is known) and the distinction between a function, a method and a
 * type.
 *
 * It is still line-oriented, not a parser. The three rules that keep it honest:
 * a symbol is only recorded when a whole line prefix matches; an import is only
 * resolved to a file that is in the analysed scope; and a relative import that
 * resolves to nothing is counted as unresolved rather than quietly dropped. The
 * module path comes from `go.mod`, so a missing `go.mod` means external imports
 * stay unresolved without pretending they were mistakes.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  ImportEdge,
  ModuleNode,
  Scope,
  StructureIndex,
  SymbolRef,
} from '../../contracts/types.js'
import { detectLanguage } from '../scope.js'

const IMPORT_BLOCK = /^[ \t]*import[ \t]*\([ \t]*$/
const IMPORT_ONE = /^[ \t]*import[ \t]+(?:[._A-Za-z]\w*[ \t]+)?["`]([^"`]+)["`]/
const IMPORT_ENTRY = /^[ \t]*(?:[._A-Za-z]\w*[ \t]+)?["`]([^"`]+)["`]/
const PACKAGE = /^[ \t]*package[ \t]+([A-Za-z_]\w*)/
const FUNC = /^[ \t]*func[ \t]+([A-Za-z_]\w*)[ \t]*\(/
const METHOD =
  /^[ \t]*func[ \t]*\([^)]*?([A-Za-z_]\w*)[ \t]*\)[ \t]*([A-Za-z_]\w*)[ \t]*\(/
const TYPE = /^[ \t]*type[ \t]+([A-Za-z_]\w*)[ \t]+(?:struct|interface|func|map|chan|\[|[A-Za-z_]\w*)/

function modulePath(text: string): string {
  const match = /^[ \t]*module[ \t]+(\S+)/m.exec(text)
  return match?.[1] ?? ''
}

function goFilesByDir(scope: Scope): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const file of scope.files) {
    if (detectLanguage(file.path) !== 'go' || file.path.endsWith('_test.go')) continue
    const dir = path.posix.dirname(file.path)
    const list = map.get(dir) ?? []
    list.push(file.path)
    map.set(dir, list)
  }
  for (const list of map.values()) list.sort()
  return map
}

/**
 * Resolves a Go import to one file in the scope.
 *
 * `module/sub/pkg` maps to the directory `sub/pkg` under the module root; the
 * first non-test file there is the representative module. A standard-library or
 * third-party import has no such directory and stays unresolved without being a
 * failure. A relative import that names nothing is the one counted as unresolved.
 */
function resolveImport(
  specifier: string,
  importer: string,
  module: string,
  byDir: Map<string, string[]>,
): { resolved: string | null; broken: boolean } {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const dir = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
    const found = byDir.get(dir)?.[0] ?? null
    return { resolved: found, broken: found === null }
  }
  if (module !== '' && (specifier === module || specifier.startsWith(`${module}/`))) {
    const rel = specifier === module ? '' : specifier.slice(module.length + 1)
    const found = byDir.get(rel)?.[0] ?? null
    // A module-internal import that has no Go file is suspicious, but it can be a
    // generated package; count it as unresolved rather than inventing a target.
    return { resolved: found, broken: found === null }
  }
  return { resolved: null, broken: false }
}

export async function indexGo(root: string, scope: Scope): Promise<StructureIndex> {
  const rootAbs = path.resolve(root)
  const byDir = goFilesByDir(scope)
  let module = ''
  try {
    module = modulePath(await readFile(path.join(rootAbs, 'go.mod'), 'utf8'))
  } catch {
    module = ''
  }

  const modules: ModuleNode[] = []
  const symbols: SymbolRef[] = []
  let unresolved = 0
  const notes: string[] = []

  for (const file of scope.files) {
    if (detectLanguage(file.path) !== 'go') continue
    let text: string
    try {
      text = await readFile(path.join(rootAbs, file.path), 'utf8')
    } catch (error) {
      notes.push(`could not read ${file.path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const imports: ImportEdge[] = []
    const seen = new Set<string>()
    let inBlock = false
    let lineNumber = 0
    for (const raw of text.split('\n')) {
      lineNumber += 1
      const line = raw.replace(/\r$/, '')
      if (IMPORT_BLOCK.test(line)) {
        inBlock = true
        continue
      }
      if (inBlock && /^[ \t]*\)[ \t]*$/.test(line)) {
        inBlock = false
        continue
      }
      const match = (inBlock ? IMPORT_ENTRY.exec(line) : IMPORT_ONE.exec(line)) ?? null
      if (match !== null) {
        const specifier = match[1] as string
        if (!seen.has(specifier)) {
          seen.add(specifier)
          const resolved = resolveImport(specifier, file.path, module, byDir)
          if (resolved.broken) unresolved += 1
          imports.push({ from: file.path, specifier, resolved: resolved.resolved })
        }
        continue
      }
      if (inBlock) continue

      if (PACKAGE.test(line)) continue
      const method = METHOD.exec(line)
      if (method !== null) {
        // The receiver is part of the identity: `Ring.Push` and `Queue.Push` are two
        // methods, and the merge dedupes symbols by `path:name`.
        symbols.push({
          name: `${method[1] as string}.${method[2] as string}`,
          kind: 'method',
          path: file.path,
          line: lineNumber,
        })
        continue
      }
      const fn = FUNC.exec(line)
      if (fn !== null) {
        symbols.push({ name: fn[1] as string, kind: 'function', path: file.path, line: lineNumber })
        continue
      }
      const type = TYPE.exec(line)
      if (type !== null) {
        symbols.push({ name: type[1] as string, kind: 'type', path: file.path, line: lineNumber })
      }
    }

    modules.push({ path: file.path, imports })
  }

  if (modules.length > 0 && module === '') {
    notes.push('no go.mod at the analysis root: Go module imports are unresolved')
  }
  return { modules, symbols, unresolved, notes }
}
