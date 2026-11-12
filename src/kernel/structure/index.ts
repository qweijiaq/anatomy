/**
 * Structure indexing, one language at a time.
 *
 * The index is built per language family and merged, because the kernel analyses a
 * repository, not a program: a polyglot tree has no shared compilation to hang an
 * index on, so each pass is independent and the merge is where they meet.
 */

import type { StructureIndex } from '../../contracts/types.js'

export { indexTypeScript } from './ts.js'

/**
 * One index from many.
 *
 * Module identity is the path and symbol identity is `path:name`, so a file counted
 * twice (a caller passing overlapping scopes) adds nothing the second time.
 * `unresolved` is a measurement rather than an identity and is always summed, and
 * `notes` are kept in first-seen order without duplicates — a caveat repeated is
 * still one caveat, but the order is the only thing telling the reader which pass
 * reported it.
 */
export function mergeIndexes(indexes: StructureIndex[]): StructureIndex {
  const merged: StructureIndex = { modules: [], symbols: [], unresolved: 0, notes: [] }
  const modulePaths = new Set<string>()
  const symbolKeys = new Set<string>()
  const seenNotes = new Set<string>()

  for (const index of indexes) {
    for (const module of index.modules) {
      if (modulePaths.has(module.path)) continue
      modulePaths.add(module.path)
      merged.modules.push(module)
    }
    for (const symbol of index.symbols) {
      const key = `${symbol.path}:${symbol.name}`
      if (symbolKeys.has(key)) continue
      symbolKeys.add(key)
      merged.symbols.push(symbol)
    }
    merged.unresolved += index.unresolved
    for (const note of index.notes) {
      if (seenNotes.has(note)) continue
      seenNotes.add(note)
      merged.notes.push(note)
    }
  }

  return merged
}
