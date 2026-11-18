/**
 * A short, deterministic map of where a repository starts and what it leans on.
 *
 * The learning points answer "what is a decision worth reading"; they do not
 * answer "where does this application begin". On a large app the second question
 * is the one a newcomer asks first, and it needs no model: entry points come from
 * the profile, hubs from resolved imports, directories from the scope.
 *
 * It is a map, not a narrative. It cannot name a domain pipeline the candidate
 * generator never surfaced; it can at least say which doors exist and which rooms
 * every corridor passes through.
 */

import path from 'node:path'

import type { ReportInput } from '../contracts/types.js'

export type StructureGuide = {
  entries: string[]
  /** Modules imported by the most other modules, with the incoming count. */
  hubs: Array<{ path: string; incoming: number }>
  /** First-level source directories, by file count. */
  dirs: Array<{ dir: string; files: number }>
}

export function structureGuide(input: ReportInput): StructureGuide {
  const incoming = new Map<string, number>()
  for (const module of input.structure?.modules ?? []) {
    for (const edge of module.imports) {
      if (edge.resolved === null || edge.resolved === module.path) continue
      incoming.set(edge.resolved, (incoming.get(edge.resolved) ?? 0) + 1)
    }
  }
  const hubs = [...incoming.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([file, count]) => ({ path: file, incoming: count }))

  const dirs = new Map<string, number>()
  for (const file of input.scope.files) {
    if (file.language === null) continue
    const dir = path.posix.dirname(file.path)
    if (dir === '.' || dir.startsWith('..')) continue
    const top = dir.split('/')[0] as string
    dirs.set(top, (dirs.get(top) ?? 0) + 1)
  }
  return {
    entries: input.profile.entryPoints.slice(0, 6),
    hubs,
    dirs: [...dirs.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([dir, files]) => ({ dir, files })),
  }
}
