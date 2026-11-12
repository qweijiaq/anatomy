import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexGeneric } from '../src/kernel/structure/generic.js'
import { selectScope } from '../src/kernel/scope.js'

async function repoOf(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ana-generic-'))
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return root
}

async function indexOf(files: Record<string, string>) {
  const root = await repoOf(files)
  const scope = await selectScope(root)
  return { root, scope, index: await indexGeneric(root, scope) }
}

describe('indexGeneric', () => {
  it('finds rust declarations, including ones behind visibility modifiers', async () => {
    const { index } = await indexOf({
      'src/lib.rs': [
        'pub struct Cache {',
        '    size: usize,',
        '}',
        '',
        'impl Cache {',
        '    pub fn new(size: usize) -> Self {',
        '        Self { size }',
        '    }',
        '',
        '    fn evict(&mut self) {}',
        '}',
      ].join('\n'),
    })

    const names = index.symbols.map((symbol) => symbol.name)
    expect(names).toContain('Cache')
    expect(names).toContain('new')
    expect(names).toContain('evict')
    expect(index.symbols.find((symbol) => symbol.name === 'evict')).toMatchObject({
      kind: 'function',
      line: 10,
    })
  })

  it('finds go and c-family declarations', async () => {
    const { index } = await indexOf({
      'main.go': ['type Node struct {', '\tnext *Node', '}', 'func walk(n *Node) {}'].join('\n'),
      'src/a.c': ['static int add(int a, int b) {', '  return a + b;', '}'].join('\n'),
    })

    const byPath = (file: string) =>
      index.symbols.filter((symbol) => symbol.path === file).map((symbol) => symbol.name)
    expect(byPath('main.go')).toEqual(['Node', 'walk'])
    expect(byPath('src/a.c')).toEqual(['add'])
  })

  it('skips commented-out declarations', async () => {
    // A symbol in the index is a claim that this line declares something; a
    // commented-out function is not a declaration.
    const { index } = await indexOf({
      'src/lib.rs': ['// fn ghost() {}', '/// fn alsoGhost() {}', 'fn real() {}'].join('\n'),
    })

    expect(index.symbols.map((symbol) => symbol.name)).toEqual(['real'])
  })

  it('claims no import graph, and says the structure is approximate', async () => {
    const { index } = await indexOf({ 'src/lib.rs': 'fn real() {}\n' })

    // An approximate edge would be a fabrication: the report's coverage note
    // already says this language is read approximately.
    expect(index.modules).toEqual([])
    expect(index.unresolved).toBe(0)
    expect(index.notes).toContain('approximate structure: declarations only, no import graph')
  })

  it('says nothing at all about a repository it is not responsible for', async () => {
    const { index } = await indexOf({ 'src/index.ts': 'export const x = 1\n' })

    expect(index.symbols).toEqual([])
    expect(index.notes).toEqual([])
  })
})
