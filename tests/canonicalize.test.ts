import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  canonicalizeFile,
  canonicalizeText,
  offsetOfLine,
  readSlice,
} from '../src/kernel/canonicalize.js'

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/encoding/${name}`, import.meta.url))

const crlfFixture = fixture('crlf.ts')
const crFixture = fixture('cr.ts')
const bomFixture = fixture('bom.ts')
const bomLatin1Fixture = fixture('bom-latin1.ts')
const latin1Fixture = fixture('latin1.ts')
const trailingFixture = fixture('trailing.ts')

const scratch = mkdtempSync(join(tmpdir(), 'anatomy-canon-'))
const bigFile = join(scratch, 'big.ts')
writeFileSync(
  bigFile,
  Array.from({ length: 500 }, (_, i) => `const v${i + 1} = ${i + 1}`).join('\n') + '\n',
)

// A final line that is whitespace only and is not followed by a newline.
const whitespaceFinalFile = join(scratch, 'whitespace-final.ts')
writeFileSync(whitespaceFinalFile, 'const a = 1\n   ')

/** Exact canonical lines `from..to` of `bigFile`, for whole-text slice assertions. */
const bigLines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `const v${from + i} = ${from + i}`)

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

  it('normalizes lone CR newlines', async () => {
    const file = await canonicalizeFile(crFixture)
    expect(file.lineCount).toBe(3)
    expect(file.text).toBe('a\nb\nc\n')
  })

  it('strips a BOM that survived latin-1 decoding', async () => {
    const file = await canonicalizeFile(bomLatin1Fixture)
    expect(file.hadBom).toBe(true)
    expect(file.encoding).toBe('latin1')
    expect(file.text).toBe('// café\n')
  })

  it('does not count a trailing newline as an extra line', async () => {
    expect((await canonicalizeFile(bigFile)).lineCount).toBe(500)
  })

  it('counts a whitespace-only final line without a trailing newline', async () => {
    const file = await canonicalizeFile(whitespaceFinalFile)
    expect(file.text).toBe('const a = 1\n')
    expect(file.lineCount).toBe(2)
    expect(offsetOfLine(file.text, 2)).toBe(12)
  })
})

describe('canonicalizeText', () => {
  it('normalizes CRLF and strips trailing whitespace on every line', () => {
    expect(canonicalizeText('a = 1  \r\nb = 2\t\r\n')).toEqual({
      text: 'a = 1\nb = 2\n',
      lineCount: 2,
    })
  })

  it('strips one leading BOM', () => {
    expect(canonicalizeText('\uFEFFa\n')).toEqual({ text: 'a\n', lineCount: 1 })
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

describe('readSlice', () => {
  it('returns a line-addressed slice with exact text', async () => {
    const slice = await readSlice(bigFile, 10, 12)
    expect(slice.startLine).toBe(10)
    expect(slice.endLine).toBe(12)
    expect(slice.truncated).toBe(false)
    expect(slice.omitted).toBeNull()
    expect(slice.text).toBe('const v10 = 10\nconst v11 = 11\nconst v12 = 12')
  })

  it('clamps out-of-range bounds instead of throwing', async () => {
    const slice = await readSlice(crlfFixture, 0, 99)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(3)
    expect(slice.truncated).toBe(false)
    expect(slice.omitted).toBeNull()
    expect(slice.text).toBe('export const a = 1\nexport const b = 2\nexport const c = 3')
  })

  it('keeps head and tail halves when over maxLines', async () => {
    const slice = await readSlice(bigFile, 1, 500, { maxLines: 10 })
    expect(slice.truncated).toBe(true)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(500)
    expect(slice.text).toBe(
      [...bigLines(1, 5), '...', ...bigLines(496, 500)].join('\n'),
    )
    // Head text is startLine..omitted.startLine-1, tail is omitted.endLine+1..endLine.
    expect(slice.omitted).toEqual({ startLine: 6, endLine: 495 })
  })

  it('truncates by default at 200 lines', async () => {
    const slice = await readSlice(bigFile, 1, 500)
    expect(slice.truncated).toBe(true)
    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(500)
    expect(slice.text).toBe(
      [...bigLines(1, 100), '...', ...bigLines(401, 500)].join('\n'),
    )
    expect(slice.omitted).toEqual({ startLine: 101, endLine: 400 })
    expect((await readSlice(bigFile, 1, 200)).truncated).toBe(false)
  })

  it('falls back to the default maxLines when maxLines is NaN or below 1', async () => {
    for (const maxLines of [Number.NaN, 0, -5]) {
      const slice = await readSlice(bigFile, 1, 500, { maxLines })
      expect(slice.omitted).toEqual({ startLine: 101, endLine: 400 })
    }
  })
})
