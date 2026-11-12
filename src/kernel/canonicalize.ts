/**
 * The single place in anatomy that decides what "the text of a file" is.
 *
 * Every downstream module (evidence extraction, snippet validation, the slice
 * reader shown to the model) must go through `canonicalizeFile`. Re-implementing
 * decoding or newline normalization elsewhere silently breaks the product
 * promise that every `Evidence.snippet` is an exact substring of the canonical
 * text and every evidence line number points at the same lines.
 */

import { readFile, stat } from 'node:fs/promises'

import type { CanonicalFile, Slice } from '../contracts/types.js'
import { DEFAULT_SLICE_MAX_LINES } from '../contracts/types.js'

/**
 * The largest file this product reads as source text.
 *
 * One number, one policy: the slice reader that shows a file to the model and
 * the validator that checks the model's citation of it must refuse exactly the
 * same files. When they disagree, an honest citation of a slice the model was
 * shown dies as if it were fabricated, and `droppedEvidence` accuses the model
 * of inventing something it read. 8 MiB is far above any hand-written source
 * file and far below anything that would hurt to decode, so a lockfile, a
 * minified bundle or a bundled dataset still never enters a run.
 */
export const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024

const UTF8_BOM = '\uFEFF'
/**
 * What a UTF-8 BOM looks like after decoding bytes as latin-1: the three bytes
 * `EF BB BF` become `ï»¿`. `TextDecoder('utf-8')` strips the BOM itself, so only
 * the latin-1 fallback can still carry it.
 */
const MOJIBAKE_BOM = '\u00EF\u00BB\u00BF'
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
    const text = buffer.toString('latin1')
    return {
      text: text.startsWith(MOJIBAKE_BOM) ? text.slice(MOJIBAKE_BOM.length) : text,
      encoding: 'latin1',
    }
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

/**
 * The one canonicalization pipeline: strip one leading BOM, normalize newlines,
 * strip trailing whitespace per line, count lines.
 *
 * The count is taken on the newline-normalized text, before trailing whitespace
 * is stripped, so a whitespace-only final line without a trailing newline still
 * counts as a line (it is stripped to empty, but it exists).
 */
export function canonicalizeText(raw: string): { text: string; lineCount: number } {
  const withoutBom = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw
  const normalized = normalizeNewlines(withoutBom)
  const lineCount = countLines(normalized)
  return { text: stripTrailingWhitespace(normalized), lineCount }
}

/** Splits canonical text into real lines (drops the phantom element after a trailing `\n`). */
function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/**
 * Reads and canonicalizes one file, refusing anything over
 * `MAX_EVIDENCE_FILE_BYTES`.
 *
 * The cap is the shared one, checked here so the slice reader shown to the model
 * cannot expose a file that the evidence validator would later refuse: both
 * sides read through this function. It is enforced on `stat` before the read, so
 * the bytes of an oversized file are never buffered.
 */
export async function canonicalizeFile(absPath: string): Promise<CanonicalFile> {
  const info = await stat(absPath)
  if (info.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(
      `${absPath} is ${info.size} bytes, over the ` +
        `${MAX_EVIDENCE_FILE_BYTES} byte read cap`,
    )
  }

  const buffer = await readFile(absPath)
  const hadBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf

  const decoded = decode(buffer)
  const canonical = canonicalizeText(decoded.text)

  return {
    path: absPath,
    text: canonical.text,
    lineCount: canonical.lineCount,
    encoding: decoded.encoding,
    hadBom,
  }
}

/**
 * 1-based line number -> 0-based character offset of that line's first character.
 *
 * A text ending in `\n` has one addressable line start beyond `countLines`:
 * `text.length`, where an empty final line would start. That is what a
 * whitespace-only final line canonicalizes to (its content is stripped, only the
 * newline before it remains), so it must stay addressable even though
 * `countLines` does not count it.
 */
export function offsetOfLine(text: string, line: number): number {
  const total = countLines(text)
  const lastAddressable = text.endsWith('\n') ? total + 1 : total
  if (!Number.isInteger(line) || line < 1 || line > lastAddressable) {
    throw new RangeError(`line ${line} is out of range 1..${lastAddressable}`)
  }
  if (line === 1) return 0

  let offset = 0
  for (let seen = 1; seen < line; seen += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) {
      throw new RangeError(`line ${line} is out of range 1..${lastAddressable}`)
    }
    offset = next + 1
  }
  return offset
}

/**
 * Lines `startLine..endLine` (1-based, inclusive in both ends) of a canonical file.
 *
 * Callers that build several slices of one file (the prompt builder does) read
 * the file once with `canonicalizeFile` and cut every window here, so a file is
 * decoded once per run rather than once per window.
 *
 * Bounds outside the file are clamped, not thrown. When the clamped span exceeds
 * `maxLines`, the head and tail halves are kept and joined with a `...` elision
 * line; `truncated` is then true and `omitted` reports the first and last real
 * line numbers that the elision replaced.
 */
export function sliceOf(
  file: CanonicalFile,
  startLine: number,
  endLine: number,
  opts?: { maxLines?: number },
): Slice {
  const lines = toLines(file.text)
  const requestedMax = opts?.maxLines ?? DEFAULT_SLICE_MAX_LINES
  const maxLines =
    Number.isFinite(requestedMax) && requestedMax >= 1
      ? Math.floor(requestedMax)
      : DEFAULT_SLICE_MAX_LINES

  if (file.lineCount === 0) {
    return {
      path: file.path,
      startLine: 0,
      endLine: 0,
      text: '',
      truncated: false,
      omitted: null,
    }
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
      omitted: null,
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
    omitted: { startLine: first + head, endLine: last - tail },
  }
}

/**
 * Reads `absPath`, canonicalizes it, and cuts lines `startLine..endLine` out of
 * it. One decode, one slice; a caller wanting several slices of one file should
 * canonicalize once and use `sliceOf`.
 */
export async function readSlice(
  absPath: string,
  startLine: number,
  endLine: number,
  opts?: { maxLines?: number },
): Promise<Slice> {
  return sliceOf(await canonicalizeFile(absPath), startLine, endLine, opts)
}
