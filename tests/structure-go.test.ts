/**
 * The Go pass is line-oriented on purpose; these tests pin the three claims it
 * makes: package-local imports resolve against the scope, methods keep their
 * receiver in the name, and a broken relative import is counted, not hidden.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexGo } from '../src/kernel/structure/go.js'
import type { Scope } from '../src/contracts/types.js'

function fixture(): { root: string; scope: Scope } {
  const root = mkdtempSync(path.join(tmpdir(), 'ana-go-'))
  mkdirSync(path.join(root, 'internal', 'ring'), { recursive: true })
  writeFileSync(path.join(root, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n')
  writeFileSync(
    path.join(root, 'main.go'),
    [
      'package main',
      '',
      'import (',
      '  "example.com/demo/internal/ring"',
      '  "fmt"',
      '  "./missing"',
      ')',
      '',
      'type Server struct{}',
      '',
      'func New() *Server { return &Server{} }',
      '',
      'func (s *Server) Run() { fmt.Println(ring.New()) }',
      '',
    ].join('\n'),
  )
  writeFileSync(
    path.join(root, 'internal', 'ring', 'ring.go'),
    ['package ring', '', 'type Ring struct{}', '', 'func New() *Ring { return &Ring{} }', ''].join('\n'),
  )
  const files = [
    { path: 'main.go', bytes: 1, lines: 1, language: 'go' },
    { path: 'internal/ring/ring.go', bytes: 1, lines: 1, language: 'go' },
  ]
  return {
    root,
    scope: {
      root,
      files,
      excluded: [],
      totals: { files: 2, bytes: 2, lines: 2 },
      byLanguage: { go: 2 },
    },
  }
}

describe('indexGo', () => {
  it('resolves module imports, keeps receivers, and counts only broken relative imports', async () => {
    const { root, scope } = fixture()
    const index = await indexGo(root, scope)

    expect(index.modules.map((module) => module.path).sort()).toEqual([
      'internal/ring/ring.go',
      'main.go',
    ])
    const main = index.modules.find((module) => module.path === 'main.go')
    expect(main?.imports.find((edge) => edge.specifier === 'example.com/demo/internal/ring')?.resolved).toBe(
      'internal/ring/ring.go',
    )
    expect(main?.imports.find((edge) => edge.specifier === 'fmt')?.resolved).toBeNull()
    expect(index.unresolved).toBe(1)

    expect(index.symbols).toContainEqual({
      name: 'Server.Run',
      kind: 'method',
      path: 'main.go',
      line: 13,
    })
    expect(index.symbols.some((symbol) => symbol.name === 'Server' && symbol.kind === 'type')).toBe(true)
    expect(index.symbols.some((symbol) => symbol.name === 'New' && symbol.path === 'main.go')).toBe(true)
  })

  it('says when there is no go.mod instead of treating module imports as broken', async () => {
    const { root, scope } = fixture()
    writeFileSync(path.join(root, 'go.mod'), 'not a go.mod\n')
    const index = await indexGo(root, scope)
    expect(index.notes.some((note) => note.includes('go.mod'))).toBe(true)
    // The module-internal import has no module path to match, so it is external.
    expect(index.unresolved).toBe(1)
  })
})
