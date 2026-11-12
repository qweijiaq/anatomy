/**
 * Structure for languages this kernel cannot parse properly.
 *
 * The product's honesty rule is that a repository it cannot read must say so
 * rather than present a README-only analysis as if it were the repository. That
 * rule is worth a little recall: a `fn`/`struct`/`def`/`func` declaration is
 * recognisable in almost every language by line shape alone, and an approximate
 * symbol index is the difference between a Rust crate producing candidates and
 * producing none.
 *
 * What this pass is:
 * - declarations only: functions, methods, classes, and type-like declarations,
 *   recognised from a line-start keyword and a name;
 * - an honest `unresolved: 0` — no imports are claimed, because an approximate
 *   edge would be a fabrication, and the report's coverage note already says the
 *   language is approximate.
 *
 * What this pass is not: a parser. A name it misses costs one candidate and is
 * recorded in `notes`; a name it invents would cost the reader's trust, so every
 * rule here matches an entire line prefix rather than guessing at structure.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { Scope, StructureIndex, SymbolKind, SymbolRef } from '../../contracts/types.js'

/**
 * One declaration rule per language family, keyed by the extension it applies to.
 *
 * Each entry matches `keyword name`, which is how these languages open a
 * declaration. Order matters only where two families share a keyword.
 */
const DECLARATION_RULES: ReadonlyArray<{
  extensions: readonly string[]
  pattern: RegExp
  kind: SymbolKind
}> = [
  // Rust: `fn`, `pub fn`, `pub(crate) fn`, `struct`, `enum`, `trait`, `impl`.
  {
    extensions: ['rs'],
    pattern: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?fn[ \t]+([A-Za-z_]\w*)/,
    kind: 'function',
  },
  {
    extensions: ['rs'],
    pattern: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:struct|enum|union|trait)[ \t]+([A-Za-z_]\w*)/,
    kind: 'class',
  },
  {
    extensions: ['rs'],
    pattern: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?impl(?:<[^>]*>)?[ \t]+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/,
    kind: 'class',
  },
  // Go: `func`, `func (r T) M(`, `type X struct`.
  {
    extensions: ['go'],
    pattern: /^[ \t]*func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/,
    kind: 'function',
  },
  {
    extensions: ['go'],
    pattern: /^[ \t]*type[ \t]+([A-Za-z_]\w*)[ \t]+(?:struct|interface)/,
    kind: 'class',
  },
  // C-family, Objective-C, C#, Java, Kotlin, Swift, Zig, Dart: `T name(`.
  {
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'cs', 'java', 'kt', 'kts', 'swift', 'dart', 'zig'],
    pattern: /^[ \t]*(?:public|private|protected|internal|static|final|override|export|func|async)[ \t]*(?:[\w<>[\]?,.]+[ \t]+)+([A-Za-z_]\w*)[ \t]*\(/,
    kind: 'function',
  },
  {
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'cs', 'java', 'kt', 'kts', 'swift', 'dart', 'zig'],
    pattern: /^[ \t]*(?:public|private|protected|internal|static|final|abstract|sealed|export)?[ \t]*(?:class|struct|enum|interface|protocol|extension|object)[ \t]+([A-Za-z_]\w*)/,
    kind: 'class',
  },
  // Ruby, PHP, Lua: `def`, `function`, and Ruby's `def self.m`.
  {
    extensions: ['rb', 'php', 'lua'],
    pattern: /^[ \t]*(?:def|function|local[ \t]+function)[ \t]+(?:self\.)?([A-Za-z_]\w*)/,
    kind: 'function',
  },
  {
    extensions: ['rb', 'php'],
    pattern: /^[ \t]*(?:class|module|interface|trait)[ \t]+([A-Za-z_]\w*)/,
    kind: 'class',
  },
]

/** Extensions this pass can say anything at all about. */
export const GENERIC_EXTENSIONS: ReadonlySet<string> = new Set(
  DECLARATION_RULES.flatMap((rule) => rule.extensions),
)

/**
 * Extension → language name, so `detectLanguage` can answer for these files.
 *
 * The name is the language the report prints ("rust", "go"), which is also what
 * the structure pass keys its rules on.
 */
export const GENERIC_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ...['rs'].map((e): [string, string] => [e, 'rust']),
  ...['go'].map((e): [string, string] => [e, 'go']),
  ...['c', 'h'].map((e): [string, string] => [e, 'c']),
  ...['cc', 'cpp', 'cxx', 'hpp', 'hh'].map((e): [string, string] => [e, 'cpp']),
  ...['m', 'mm'].map((e): [string, string] => [e, 'objc']),
  ...['cs'].map((e): [string, string] => [e, 'csharp']),
  ...['java'].map((e): [string, string] => [e, 'java']),
  ...['kt', 'kts'].map((e): [string, string] => [e, 'kotlin']),
  ...['swift'].map((e): [string, string] => [e, 'swift']),
  ...['dart'].map((e): [string, string] => [e, 'dart']),
  ...['zig'].map((e): [string, string] => [e, 'zig']),
  ...['rb'].map((e): [string, string] => [e, 'ruby']),
  ...['php'].map((e): [string, string] => [e, 'php']),
  ...['lua'].map((e): [string, string] => [e, 'lua']),
])

function extensionOf(filePath: string): string {
  const name = filePath.split('\\').join('/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Index every declaration-looking line in the languages `GENERIC_EXTENSIONS` covers.
 *
 * Blank and comment lines are skipped before matching so a commented-out function
 * is not reported as a symbol: a symbol in the index is a claim that this line
 * declares something.
 */
export async function indexGeneric(root: string, scope: Scope): Promise<StructureIndex> {
  const rootAbs = path.resolve(root)
  const symbols: SymbolRef[] = []
  const notes: string[] = []
  const seen = new Set<string>()

  for (const file of scope.files) {
    const extension = extensionOf(file.path)
    if (!GENERIC_EXTENSIONS.has(extension)) continue

    let text: string
    try {
      text = await readFile(path.join(rootAbs, file.path), 'utf8')
    } catch {
      continue
    }

    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) continue
      for (const rule of DECLARATION_RULES) {
        if (!rule.extensions.includes(extension)) continue
        const match = rule.pattern.exec(line)
        const name = match?.[1]
        if (name === undefined) continue
        const key = `${file.path}:${name}`
        if (seen.has(key)) break
        seen.add(key)
        symbols.push({ name, kind: rule.kind, path: file.path, line: index + 1 })
        break
      }
    }
  }

  if (symbols.length > 0) {
    notes.push('approximate structure: declarations only, no import graph')
  }
  return { modules: [], symbols, unresolved: 0, notes }
}
