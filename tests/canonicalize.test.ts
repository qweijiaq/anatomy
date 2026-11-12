import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  canonicalizeFile,
  lineRangeOfSnippet,
  offsetOfLine,
  readSlice,
} from '../src/kernel/canonicalize.js'

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/encoding/${name}`, import.meta.url))

const crlfFixture = fixture('crlf.ts')
const bomFixture = fixture('bom.ts')
const latin1Fixture = fixture('latin1.ts')
const trailingFixture = fixture('trailing.ts')

const scratch = mkdtempSync(join(tmpdir(), 'anatomy-canon-'))
const bigFile = join(scratch, 'big.ts')
writeFileSync(
  bigFile,
  Array.from({ length: 500 }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n',
)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('canonicalizeFile', () => {
  it('normalizes CRLF so line numbers do not shift', async () => {
    const file = await canonicalizeFile(crlfFixture)
    expect(file.lineCount).toBe(3)
    expect(file.text.includes('\r')).toBe(false)
    expect(file.encoding).toBe('utf8')
    expect(file.hadBom).toBe(false)
  })

  it('strips the BOM so first-line snippets can match', async () => {
    const file = await canonicalizeFile(bomFixture)
    expect(file.text.startsWith('import')).toBe(true)
    expect(file.hadBom).toBe(true)
    expect(file.text.includes('\uFEFF')).toBe(false)
  })

  it('falls back to latin-1 instead of throwing on invalid UTF-8', async () => {
    const file = await canonicalizeFile(latin1Fixture)
    expect(file.encoding).toBe('latin1')
    expect(file.text).toContain('café')
    expect(file.lineCount).toBe(2)
  })

  it('strips trailing whitespace per line but keeps indentation', async () => {
    const file = await canonicalizeFile(trailingFixture)
    const lines = file.text.split('\n')
    expect(lines[0]).toBe('// trailing whitespace fixture')
    expect(lines[1]).toBe('export const y = 2')
    expect(lines[3]).toBe('\t  keep indentation')
  })

  it('does not count a trailing newline as an extra line', async () => {
    expect((await canonicalizeFile(bigFile)).lineCount).toBe(500)
  })
})

describe('offsetOfLine', () => {
  it('maps a 1-based line to a 0-based character offset', () => {
    expect(offsetOfLine('a\nb', 1)).toBe(0)
    expect(offsetOfLine('a\nb', 2)).toBe(2)
    expect(offsetOfLine('a\nb\n', 2)).toBe(2)
  })

  it('throws RangeError out of range', () => {
    expect(() => offsetOfLine('a\nb', 5)).toThrow(RangeError)
    expect(() => offsetOfLine('a\nb', 0)).toThrow(RangeError)
  })
})

describe('lineRangeOfSnippet', () => {
  it('locates a snippet whose line had trailing whitespace', async () => {
    const canonText = (await canonicalizeFile(trailingFixture)).text
    expect(lineRangeOfSnippet(canonText, 'const x = 1')).toEqual({
      startLine: 3,
      endLine: 3,
    })
  })

  it('returns null when the snippet is absent', () => {
    expect(lineRangeOfSnippet('a\nb', 'nope')).toBeNull()
  })

  it('returns the range of the first match only', () => {
    expect(lineRangeOfSnippet('x\nx\nx', 'x')).toEqual({ startLine: 1, endLine: 1 })
  })

  it('spans multiple lines for a multi-line snippet', () => {
    expect(lineRangeOfSnippet('a\nb\nc\n', 'b\nc')).toEqual({ startLine: 2, endLine: 3 })
  })

  it('rejects an empty snippet', () => {
    expect(lineRangeOfSnippet('a\nb', '')).toBeNull()
  })
})

describe('readSlice', () => {
  it('returns a line-addressed slice with exact text', async () => {
    const slice = await readSlice(bigFile, 10, 12)
    expect(slice.startLine).toBe(10)
    expect(slice.endLine).toBe(12)
    expect(slice.truncated).toBe(false)
    expect(slice.text).toBe('const v10 = 10\nconst v11 = 11\nconst v12 = 12')
  })

  it('clamps out-of-range bounds instead of throwing', async () => {
    const slice = await readSlice(crlfFixture, 0, 99)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(3)
    expect(slice.truncated).toBe(false)
    expect(slice.text).toBe('export const a = 1\nexport const b = 2\nexport const c = 3')
  })

  it('keeps head and tail halves when over maxLines', async () => {
    const slice = await readSlice(bigFile, 1, 500, { maxLines: 10 })
    expect(slice.truncated).toBe(true)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(500)
    expect(slice.text.startsWith('const v1 = 1\n')).toBe(true)
    expect(slice.text.endsWith('const v500 = 500')).toBe(true)
    expect(slice.text).toContain('const v5 = 5')
    expect(slice.text).not.toContain('const v6 = 6\n')
    // 10 kept lines plus one elision line
    expect(slice.text.split('\n').length).toBeLessThanOrEqual(11)
  })

  it('truncates by default at 200 lines', async () => {
    expect((await readSlice(bigFile, 1, 500)).truncated).toBe(true)
    expect((await readSlice(bigFile, 1, 200)).truncated).toBe(false)
  })
})
