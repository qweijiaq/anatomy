/**
 * Structure of TypeScript and JavaScript: which file imports which, and what each
 * file declares.
 *
 * Two decisions shape this module.
 *
 * 1. `ts.createSourceFile` only — no Program, no type checker. Type checking needs
 *    a project-wide compilation, which the kernel must never do: the analysis runs
 *    on repositories it cannot build, and a single broken file would take the whole
 *    run's structure with it. The parser alone works on code that does not compile,
 *    and its recovery is what keeps a broken file's imports readable.
 * 2. A `resolved` edge is a claim that an indexed module exists. Resolution is
 *    hand-rolled against the *scope's* file set rather than the filesystem, and the
 *    hit must be a path this pass emitted a `ModuleNode` for — a `.css`, `.json` or
 *    `.d.ts` target resolves to `null` — so an edge can only ever point at something
 *    the reader can actually be shown. A package specifier is not a failure, and
 *    neither is a non-module target, so only a broken relative import increments
 *    `unresolved`.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import ts from 'typescript'

import type {
  ImportEdge,
  ModuleNode,
  Scope,
  StructureIndex,
  SymbolKind,
  SymbolRef,
} from '../../contracts/types.js'
import { detectLanguage } from '../scope.js'

/** Language names `detectLanguage` returns for a file this module can parse. */
const PARSED_LANGUAGES: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

/** Probe suffixes for a relative base, in the order the spec fixes. */
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'] as const

/**
 * Declaration files describe code that lives elsewhere — a package's shipped
 * `.d.ts`, or a hand-written ambient file. They declare no implementation to learn
 * from, so they are resolution targets but never parsed modules.
 */
const DECLARATION_FILE = /\.d\.ts$/

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim() || 'unreadable'
}

// --- specifiers -----------------------------------------------------------

/** `./x`, `../x`, `.` and `..` name a file relative to the importer. */
function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  )
}

/**
 * Candidate paths for one relative base, most specific first: the base itself,
 * then an ESM `.js`/`.jsx` specifier's TypeScript twin, then the probe suffixes,
 * then a directory index. The twin comes before the suffixes because `./b.js`
 * names `b.ts` in every ESM-TypeScript project, and `b.js.ts` names nothing.
 */
function candidatesFor(base: string): string[] {
  const candidates = [base]
  const esm = /\.(?:js|jsx)$/.exec(base)
  if (esm !== null) {
    const stem = base.slice(0, esm.index)
    // The twin follows the specifier's own kind: `./c.jsx` names a React component,
    // so `c.tsx` is the likelier target, and probing `c.ts` first would bind the edge
    // to the plainer file that happens to share the stem.
    const twins = esm[0] === '.jsx' ? ['.tsx', '.ts'] : ['.ts', '.tsx']
    for (const extension of twins) candidates.push(`${stem}${extension}`)
    candidates.push(`${stem}.d.ts`)
  }
  for (const extension of PROBE_EXTENSIONS) candidates.push(`${base}${extension}`)
  for (const extension of PROBE_EXTENSIONS) candidates.push(`${base}/index${extension}`)
  return candidates
}

/**
 * The kept file a relative specifier names, or `null`.
 *
 * `kept` is the scope's path set, so a specifier pointing below a pruned directory
 * (`vendor/`, `dist/`) resolves to nothing: an edge the reader cannot follow is a
 * false boundary, and inventing one is worse than reporting none.
 */
function resolveRelativeSpecifier(
  specifier: string,
  fromPath: string,
  kept: ReadonlySet<string>,
): string | null {
  const cleaned = specifier.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), cleaned || '.'))
  // `../../` above the analysed root names a file the reader will never see.
  if (base === '..' || base.startsWith('../')) return null
  for (const candidate of candidatesFor(base)) {
    if (kept.has(candidate)) return candidate
  }
  return null
}

// --- declarations ---------------------------------------------------------

/** The name a declaration binds, when it has a simple one. */
function declarationName(node: ts.Node): string | null {
  const name = (node as { name?: ts.Node }).name
  if (name === undefined) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

/** Destructured bindings (`const { a, b } = ...`) bind top-level names too. */
function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out)
  }
}

/** 1-based line of the declared name, so a reader lands on `helper`, not on `export`. */
function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  const target = (node as { name?: ts.Node }).name ?? node
  return sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile)).line + 1
}

function pushSymbol(
  symbols: SymbolRef[],
  name: string,
  kind: SymbolKind,
  filePath: string,
  line: number,
): void {
  symbols.push({ name, kind, path: filePath, line })
}

/**
 * Every declaration a namespace body exports. Ambient namespaces (`declare
 * namespace`, a `.d.ts` style block) export their members implicitly, so the members
 * are collected regardless of an `export` modifier rather than silently dropped.
 */
function collectNamespaceMembers(
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile,
  filePath: string,
  symbols: SymbolRef[],
): void {
  for (const statement of statements) {
    collectDeclaration(statement, sourceFile, filePath, symbols)
  }
}

/**
 * One top-level declaration. Nested function bodies and class members are not
 * walked: the unit of design is the declaration, and a local helper inside a
 * function is not something a later stage can point at independently.
 */
function collectDeclaration(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  filePath: string,
  symbols: SymbolRef[],
): void {
  const simple = (kind: SymbolKind): void => {
    const name = declarationName(statement)
    if (name !== null) pushSymbol(symbols, name, kind, filePath, lineOf(statement, sourceFile))
  }

  if (ts.isFunctionDeclaration(statement)) {
    simple('function')
  } else if (ts.isClassDeclaration(statement)) {
    simple('class')
  } else if (ts.isInterfaceDeclaration(statement)) {
    simple('interface')
  } else if (ts.isTypeAliasDeclaration(statement)) {
    simple('type')
  } else if (ts.isEnumDeclaration(statement)) {
    // The contract has no `enum` kind, and an enum is a type-level declaration.
    simple('type')
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      // Without an initializer a binding asserts a type rather than introducing a
      // value (`declare const x: number`), so there is no declaration to point at.
      if (declaration.initializer === undefined) continue
      const names: string[] = []
      collectBindingNames(declaration.name, names)
      const line = lineOf(declaration, sourceFile)
      // `let` and `var` are not separate kinds in the contract; the mutability is
      // visible in the declaration itself, which the reader can be shown.
      for (const name of names) pushSymbol(symbols, name, 'const', filePath, line)
    }
  } else if (ts.isModuleDeclaration(statement) && statement.body !== undefined) {
    // `namespace A.B { … }` nests: the outer body is another `ModuleDeclaration`, so
    // recursing only on a `ModuleBlock` would drop every member of a dotted name.
    if (ts.isModuleBlock(statement.body)) {
      collectNamespaceMembers(statement.body.statements, sourceFile, filePath, symbols)
    } else if (ts.isModuleDeclaration(statement.body)) {
      collectDeclaration(statement.body, sourceFile, filePath, symbols)
    }
  }
}

// --- imports --------------------------------------------------------------

/**
 * The module specifiers one statement depends on: `import`, `export ... from`,
 * `import x = require()`. Dynamic `import()` and `require()` calls inside bodies are
 * not chased — a call is a runtime path, not a static edge, and guessing at one
 * would put an edge in the graph the reader cannot rely on.
 */
function statementSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    const specifier = statement.moduleSpecifier
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) return specifier.text
    return null
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
    const expression = statement.moduleReference.expression
    if (ts.isStringLiteralLike(expression)) return expression.text
  }
  return null
}

// --- parsing --------------------------------------------------------------

type ParseDiagnostics = { parseDiagnostics?: readonly unknown[] }

/**
 * Whether the parser had to recover. `parseDiagnostics` is not in the public
 * typings — it is the same list `createSourceFile` has always collected, and the
 * alternative (a Program) is exactly what this module refuses to build.
 */
function hasParseErrors(sourceFile: ts.SourceFile): boolean {
  const diagnostics = (sourceFile as unknown as ParseDiagnostics).parseDiagnostics
  return Array.isArray(diagnostics) && diagnostics.length > 0
}

/**
 * Indexes every TypeScript/JavaScript file in `scope` under `root`.
 *
 * Structure only: modules with their edges, and top-level declarations. Nothing
 * here throws on a bad file — an unreadable or syntactically broken file still
 * contributes the imports and symbols the parser recovered, and the failure is
 * reported once in `notes` at the end, because a caveat must travel with the
 * findings it qualifies.
 */
export async function indexTypeScript(root: string, scope: Scope): Promise<StructureIndex> {
  const rootAbs = path.resolve(root)
  const kept = new Set(scope.files.map((file) => file.path))
  const modules: ModuleNode[] = []
  const symbols: SymbolRef[] = []
  const notes: string[] = []
  let unresolved = 0
  let parseErrors = 0

  for (const file of scope.files) {
    if (!PARSED_LANGUAGES.has(detectLanguage(file.path) ?? '')) continue
    if (DECLARATION_FILE.test(file.path)) continue

    let text: string
    try {
      text = await readFile(path.join(rootAbs, file.path), 'utf8')
    } catch (error) {
      notes.push(`could not read ${file.path}: ${reasonOf(error)}`)
      continue
    }

    const sourceFile = ts.createSourceFile(file.path, text, ts.ScriptTarget.ES2022, true)
    if (hasParseErrors(sourceFile)) parseErrors += 1

    const seen = new Set<string>()
    const imports: ImportEdge[] = []
    for (const statement of sourceFile.statements) {
      const specifier = statementSpecifier(statement)
      // One edge per specifier: `import a` and `import type a` from one module are
      // one dependency, and a duplicate edge says nothing new.
      if (specifier !== null && !seen.has(specifier)) {
        seen.add(specifier)
        imports.push({ from: file.path, specifier, resolved: null })
      }
      collectDeclaration(statement, sourceFile, file.path, symbols)
    }

    modules.push({ path: file.path, imports })
  }

  // Edges are resolved once every module is known, because a `resolved` path is a
  // promise that a node exists: a `.css`, `.json` or `.d.ts` target is a real kept
  // file but never a `ModuleNode`, and an edge pointing at one is exactly the dangling
  // edge every consumer would otherwise have to guard against. A hit on such a file is
  // not a broken specifier, so it stays out of the `unresolved` tally.
  const emitted = new Set(modules.map((module) => module.path))
  for (const module of modules) {
    for (const edge of module.imports) {
      if (!isRelativeSpecifier(edge.specifier)) continue
      const target = resolveRelativeSpecifier(edge.specifier, module.path, kept)
      if (target === null) {
        unresolved += 1
      } else if (emitted.has(target)) {
        edge.resolved = target
      }
    }
  }

  if (parseErrors > 0) notes.push(`parse errors in ${parseErrors} files`)

  modules.sort((a, b) => byCodeUnit(a.path, b.path))
  symbols.sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line || byCodeUnit(a.name, b.name))

  return { modules, symbols, unresolved, notes }
}
