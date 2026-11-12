/**
 * The single place in anatomy that decides what "the text of a file" is.
 *
 * Every downstream module (evidence extraction, snippet validation, the slice
 * reader shown to the model) must go through `canonicalizeFile`. Re-implementing
 * decoding or newline normalization elsewhere silently breaks the product
 * promise that every `Evidence.snippet` is an exact substring of the canonical
 * text and every evidence line number points at the same lines.
 */

import { readFile } from 'node:fs/promises'

import type { CanonicalFile, Slice } from '../contracts/types.js'
import { DEFAULT_SLICE_MAX_LINES } from '../contracts/types.js'

const UTF8_BOM = '\uFEFF'
const ELISION = '...'

/**
 * Decodes with a fatal UTF-8 decoder so invalid byte sequences throw instead of
 * being replaced with U+FFFD (a replacement character would poison snippets).
 * Falls back to latin-1, the historical byte-preserving interpretation.
 */
function decode(buffer: Buffer): { text: string; encoding: CanonicalFile['encoding'] } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf8' }
  } catch {
    return { text: buffer.toString('latin1'), encoding: 'latin1' }
  }
}

/** Normalizes newlines: `\r\n` first, then stray `\r`. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Strips trailing blanks from every line with a per-line `/[ \t]+$/` replace.
 * `trim()` is never used: it would eat leading indentation and shift every
 * column offset a snippet depends on.
 */
function stripTrailingWhitespace(text: string): string {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    lines[i] = (lines[i] as string).replace(/[ \t]+$/, '')
  }
  return lines.join('\n')
}

/**
 * Line count by `\n`. A trailing newline does not create an extra empty line,
 * so `"a\nb\n"` has 2 lines. An empty text has 0 lines.
 */
function countLines(text: string): number {
  if (text.length === 0) return 0
  let newlines = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    newlines += 1
  }
  return text.endsWith('\n') ? newlines : newlines + 1
}

/** Splits canonical text into real lines (drops the phantom element after a trailing `\n`). */
function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

export async function canonicalizeFile(absPath: string): Promise<CanonicalFile> {
  const buffer = await readFile(absPath)
  const hadBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf

  const decoded = decode(buffer)
  let text = decoded.text
  if (text.startsWith(UTF8_BOM)) text = text.slice(UTF8_BOM.length)

  text = stripTrailingWhitespace(normalizeNewlines(text))

  return {
    path: absPath,
    text,
    lineCount: countLines(text),
    encoding: decoded.encoding,
    hadBom,
  }
}

/**
 * 1-based line number -> 0-based character offset of that line's first character.
 * Line `lineCount` of a file ending in `\n` resolves to the offset just past the
 * final newline, which is where an empty last line would start.
 */
export function offsetOfLine(text: string, line: number): number {
  const total = countLines(text)
  if (!Number.isInteger(line) || line < 1 || line > total) {
    throw new RangeError(`line ${line} is out of range 1..${total}`)
  }
  if (line === 1) return 0

  let offset = 0
  for (let seen = 1; seen < line; seen += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) {
      throw new RangeError(`line ${line} is out of range 1..${total}`)
    }
    offset = next + 1
  }
  return offset
}

/**
 * Range of the first occurrence of `snippet` in `fileText`, or `null`.
 * An empty snippet never locates anything: it would match at offset 0 and
 * produce meaningless evidence.
 */
export function lineRangeOfSnippet(
  fileText: string,
  snippet: string,
): { startLine: number; endLine: number } | null {
  if (snippet.length === 0) return null
  const index = fileText.indexOf(snippet)
  if (index === -1) return null

  const startLine = countLines(fileText.slice(0, index)) + 1

  const matched = fileText.slice(index, index + snippet.length)
  let newlines = 0
  for (let i = matched.indexOf('\n'); i !== -1; i = matched.indexOf('\n', i + 1)) {
    newlines += 1
  }
  // A snippet ending in a newline belongs to the previous line, not the next one.
  const endLine = matched.endsWith('\n')
    ? startLine + newlines - 1
    : startLine + newlines

  return { startLine, endLine: Math.max(startLine, endLine) }
}

/**
 * Reads lines `startLine..endLine` (1-based, inclusive in both ends) of the
 * canonical form of `absPath`.
 *
 * Bounds outside the file are clamped, not thrown. When the clamped span exceeds
 * `maxLines`, the head and tail halves are kept and joined with a `...` elision
 * line; `truncated` is then true.
 */
export async function readSlice(
  absPath: string,
  startLine: number,
  endLine: number,
  opts?: { maxLines?: number },
): Promise<Slice> {
  const file = await canonicalizeFile(absPath)
  const lines = toLines(file.text)
  const maxLines = Math.max(1, Math.floor(opts?.maxLines ?? DEFAULT_SLICE_MAX_LINES))

  if (file.lineCount === 0) {
    return { path: file.path, startLine: 0, endLine: 0, text: '', truncated: false }
  }

  const requestedLow = Math.min(startLine, endLine)
  const requestedHigh = Math.max(startLine, endLine)
  const first = Math.min(Math.max(requestedLow, 1), file.lineCount)
  const last = Math.min(Math.max(requestedHigh, 1), file.lineCount)

  const span = last - first + 1
  if (span <= maxLines) {
    return {
      path: file.path,
      startLine: first,
      endLine: last,
      text: lines.slice(first - 1, last).join('\n'),
      truncated: false,
    }
  }

  const head = Math.ceil(maxLines / 2)
  const tail = maxLines - head
  const headText = lines.slice(first - 1, first - 1 + head).join('\n')
  const tailText = tail > 0 ? '\n' + lines.slice(last - tail, last).join('\n') : ''

  return {
    path: file.path,
    startLine: first,
    endLine: last,
    text: `${headText}\n${ELISION}${tailText}`,
    truncated: true,
  }
}
