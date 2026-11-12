/**
 * Candidate signals: the rules that decide where a reader ever looks.
 *
 * This module is the only filter between a few hundred thousand lines and the
 * thirty places a model will actually read, and it runs with no call to one, so
 * the rules here *are* the product's taste. Two failure modes decide whether the
 * output is worth anything:
 *
 * 1. False positives. Vendored code, generated boilerplate and framework glue
 *    scored as the project's own design. A reader handed thirty mediocre points
 *    stops trusting the report, so every rule below carries a guard that makes it
 *    fire *less*: a name the file imported is not a hand-written wheel, a binding
 *    initialised with `new Library(...)` is a call rather than an implementation,
 *    and a generated banner is not a decision trace.
 * 2. Missing the real thing. A hand-written scheduler, or a comment that explains
 *    a non-obvious tradeoff, has to outrank a merely long file.
 *
 * Nothing here parses a project, builds a program, or runs a compiler. A single
 * line-oriented scanner blanks comments and string bodies once, and every rule
 * reads that one view, so a file that does not compile still scores the same as
 * one that does — the analysis runs on repositories it cannot build.
 *
 * Determinism is part of the contract: the same repository produces byte-identical
 * candidates across runs. No clock, no environment, no locale-sensitive compare,
 * and every output list is sorted by an explicit total order.
 */

import path from 'node:path'

import type {
  Candidate,
  CanonicalFile,
  Scope,
  ScopeFile,
  SignalKind,
  StructureIndex,
} from '../contracts/types.js'
import { DEFAULT_TOP_K } from '../contracts/types.js'
import { canonicalizeFile } from './canonicalize.js'
import { detectLanguage } from './scope.js'

export const SIGNAL_WEIGHTS: Record<SignalKind, number> = {
  'custom-infra': 3,
  'decision-trace': 3,
  complexity: 2,
  abstraction: 2,
  evolution: 1,
  'test-spec': 1,
}

/**
 * Weight order, used for every kind tie-break. A total order over kinds keeps
 * the output stable when two kinds score the same.
 */
const KIND_ORDER: readonly SignalKind[] = [
  'custom-infra',
  'decision-trace',
  'complexity',
  'abstraction',
  'evolution',
  'test-spec',
]

const KIND_RANK: ReadonlyMap<SignalKind, number> = new Map(
  KIND_ORDER.map((kind, index) => [kind, index]),
)

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A function body longer than this many lines is a difficulty hot spot. */
const LONG_FUNCTION_LINES = 60
/** Nesting *inside* a function body: 4 is ordinary, 5 is a hot spot. */
const DEEP_NESTING = 4
/** A leaf module this many others import is an abstraction boundary. */
const MIN_IMPORTERS = 3
/** Assertions inside one test that pin behaviour densely. */
const DENSE_ASSERTIONS = 4
/** Fixture setup references that make a test a specification. */
const FIXTURE_REFERENCES = 3
/** A block of hits wider than this is more than one finding. */
const GROUP_MAX_LINES = 120
/** ...and each finding is at most this many lines. */
const BUCKET_LINES = 50

// --- language families ----------------------------------------------------

type Family = 'js' | 'py'

const JS_LANGUAGES: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

/**
 * The two families this module can score, or `null` for a file with nothing
 * analysable in it. Language comes from `detectLanguage`, the same function the
 * scope uses, so a file the scope counted as unanalysable is never scored here.
 */
function familyOf(filePath: string): Family | null {
  // A `.d.ts` file is declarations only: no behaviour to read, and every name in it
  // describes somebody else's implementation.
  if (/\.d\.ts$/i.test(filePath)) return null
  const language = detectLanguage(filePath)
  if (language === null) return null
  if (language === 'py') return 'py'
  return JS_LANGUAGES.has(language) ? 'js' : null
}

// --- one line-oriented view of the text -----------------------------------

type Span = { line: number; endLine: number; text: string }

type Scan = {
  /** `text` with comment and string bodies blanked to spaces; newlines kept. */
  code: string
  comments: Span[]
  strings: Span[]
}

type Quote = { open: string; close: string; multiline: boolean }

function quotesOf(family: Family): Quote[] {
  if (family === 'py') {
    // Python has no block comments: a triple-quoted string is the idiom, and its
    // text is read as a string. A module docstring therefore still yields a
    // decision trace, which is exactly the intent.
    return [
      { open: "'''", close: "'''", multiline: true },
      { open: '"""', close: '"""', multiline: true },
      { open: "'", close: "'", multiline: false },
      { open: '"', close: '"', multiline: false },
    ]
  }
  return [
    { open: "'", close: "'", multiline: false },
    { open: '"', close: '"', multiline: false },
    { open: '`', close: '`', multiline: true },
  ]
}

function commentSyntaxOf(family: Family): { line: string | null; blocks: Quote[] } {
  return family === 'py'
    ? { line: '#', blocks: [] }
    : { line: '//', blocks: [{ open: '/*', close: '*/', multiline: true }] }
}

/**
 * Whether the `/` at `index` opens a regular expression rather than dividing.
 *
 * Not a language rule — a heuristic on the previous non-space character, the same
 * one every formatterless tool uses, because there is no lexer here. It matters
 * for one concrete failure: a regex body is not code, so `unsafe` inside
 * `/unsafe entry/` must not be read as a concurrency primitive.
 */
function startsRegex(text: string, index: number): boolean {
  let previous = index - 1
  while (previous >= 0) {
    const char = text.charAt(previous)
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') previous -= 1
    else break
  }
  if (previous < 0) return true
  return '([{,;:=!&|?+-*%^~<>'.includes(text.charAt(previous))
}

/** Replaces the given (sorted, disjoint) ranges with spaces, keeping newlines. */
function blankRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += text.slice(cursor, range.start)
    out += text.slice(range.start, range.end).replace(/[^\n]/g, ' ')
    cursor = range.end
  }
  return out + text.slice(cursor)
}

/**
 * One pass over the file, collecting comments and string bodies and producing the
 * comment-free view every structural rule reads.
 *
 * Known simplifications, all of which cost a *miss* rather than a false hit where
 * they matter: a JavaScript regex literal containing a quote or `//` is read as a
 * string or comment (there is no parser here to tell them apart), and a template
 * literal is consumed whole, so substitutions inside it are blanked too. Both keep
 * braces balanced, which is what the block scan needs.
 */
function scanSource(text: string, family: Family): Scan {
  const commentSyntax = commentSyntaxOf(family)
  const quotes = quotesOf(family)
  const comments: Span[] = []
  const strings: Span[] = []
  const ranges: Array<{ start: number; end: number }> = []

  let line = 1
  let index = 0

  const advanceTo = (end: number): void => {
    for (let i = index; i < end; i += 1) if (text.charCodeAt(i) === 10) line += 1
    index = end
  }

  while (index < text.length) {
    const marker = commentSyntax.line
    if (marker !== null && text.startsWith(marker, index)) {
      const start = index
      let end = text.indexOf('\n', index)
      if (end === -1) end = text.length
      comments.push({ line, endLine: line, text: text.slice(start + marker.length, end) })
      ranges.push({ start, end })
      advanceTo(end)
      continue
    }

    const block = commentSyntax.blocks.find((candidate) => text.startsWith(candidate.open, index))
    if (block !== undefined) {
      const start = index
      const startLine = line
      const closeAt = text.indexOf(block.close, index + block.open.length)
      const end = closeAt === -1 ? text.length : closeAt + block.close.length
      const body = text.slice(start + block.open.length, closeAt === -1 ? text.length : closeAt)
      ranges.push({ start, end })
      advanceTo(end)
      comments.push({ line: startLine, endLine: line, text: body })
      continue
    }

    if (family === 'js' && text.charAt(index) === '/' && startsRegex(text, index)) {
      const start = index
      let cursor = index + 1
      let inClass = false
      let closed = false
      while (cursor < text.length) {
        const char = text.charAt(cursor)
        if (char === '\\') {
          cursor += 2
          continue
        }
        if (char === '\n') break
        if (char === '[') inClass = true
        else if (char === ']') inClass = false
        else if (char === '/' && !inClass) {
          closed = true
          break
        }
        cursor += 1
      }
      const end = closed ? Math.min(cursor + 1, text.length) : Math.min(cursor, text.length)
      ranges.push({ start, end })
      advanceTo(end)
      continue
    }

    const quote = quotes.find((candidate) => text.startsWith(candidate.open, index))
    if (quote !== undefined) {
      const start = index
      const startLine = line
      let cursor = index + quote.open.length
      let closed = false
      while (cursor < text.length) {
        const char = text.charAt(cursor)
        if (char === '\\') {
          cursor += 2
          continue
        }
        if (!quote.multiline && char === '\n') break
        if (text.startsWith(quote.close, cursor)) {
          closed = true
          break
        }
        cursor += 1
      }
      const innerEnd = Math.min(cursor, text.length)
      const end = closed ? innerEnd + quote.close.length : innerEnd
      ranges.push({ start, end })
      advanceTo(end)
      strings.push({ line: startLine, endLine: line, text: text.slice(start + quote.open.length, innerEnd) })
      continue
    }

    if (text.charCodeAt(index) === 10) line += 1
    index += 1
  }

  return { code: blankRanges(text, ranges), comments, strings }
}

// --- small text helpers ---------------------------------------------------

/**
 * Every match of `re` in `text`. A fresh global regex per call, so a `lastIndex`
 * left behind by a caller can never leak into the next file's scoring.
 */
function* matches(text: string, re: RegExp): Generator<RegExpExecArray> {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  yield* text.matchAll(new RegExp(re.source, flags))
}

function countMatches(text: string, re: RegExp): number {
  let count = 0
  for (const _match of matches(text, re)) count += 1
  return count
}

function newlineOffsets(text: string): number[] {
  const offsets: number[] = []
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) offsets.push(i)
  return offsets
}

/** 1-based line of a 0-based character offset. */
function lineAt(newlines: readonly number[], offset: number): number {
  let low = 0
  let high = newlines.length
  while (low < high) {
    const mid = (low + high) >> 1
    if ((newlines[mid] as number) < offset) low = mid + 1
    else high = mid
  }
  return low + 1
}

/** Case- and separator-insensitive form used for every name comparison. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// --- blocks: what a hit belongs to ---------------------------------------

type BlockSpan = { startLine: number; endLine: number }

/**
 * Top-level brace groups of JavaScript, so a hit inside a function body has a
 * stable identity. Only *depth-one* groups are blocks: hits inside an `if` inside a
 * function belong to the function, not to the branch.
 */
function jsBlocks(code: string): BlockSpan[] {
  const blocks: BlockSpan[] = []
  const stack: number[] = []
  let line = 1
  for (let index = 0; index < code.length; index += 1) {
    const char = code.charAt(index)
    if (char === '\n') line += 1
    else if (char === '{') stack.push(line)
    else if (char === '}') {
      const open = stack.pop()
      if (open !== undefined && stack.length === 0) blocks.push({ startLine: open, endLine: line })
    }
  }
  return blocks
}

/**
 * Top-level statement blocks of Python, by indentation: a column-zero line ending
 * in `:` opens one, and the next column-zero statement closes it. A comment or a
 * blank line never closes a block, because a comment inside a function belongs to
 * that function.
 */
function pyBlocks(text: string): BlockSpan[] {
  const lines = text.split('\n')
  const blocks: BlockSpan[] = []
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^\s/.test(line)) continue
    if (start !== -1) {
      blocks.push({ startLine: start + 1, endLine: index })
      start = -1
    }
    if (trimmed.endsWith(':')) start = index
  }
  if (start !== -1) blocks.push({ startLine: start + 1, endLine: lines.length })
  return blocks
}

/** Index of the innermost block containing `line`, or -1 for module level. */
function blockIndexAt(blocks: readonly BlockSpan[], line: number): number {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as BlockSpan
    if (line >= block.startLine && line <= block.endLine) return index
  }
  return -1
}

// --- function spans, for complexity --------------------------------------

type PlacedSpan = {
  startLine: number
  endLine: number
  /** Nesting levels *inside* the body; the body itself is level 0. */
  nesting: number
  /** Set by the languages whose spans name themselves (Python). */
  name?: string
}

type FunctionSpan = PlacedSpan & {
  bodyStart: number
  bodyEnd: number
}

const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
])

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(code: string, open: number): number {
  let depth = 0
  for (let index = open; index < code.length; index += 1) {
    const char = code.charAt(index)
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const CONTROL_HEADER = /^(?:else|if|for|while|switch|catch|with|try|finally|do)\b/
/**
 * A control clause at the *tail* of a header.
 *
 * The header starts after the previous `;`, `{` or `}`, and semicolon-free code has
 * none of those between two statements: the header of `if (x > 0) {` written under
 * `const x = a + 1` begins with `const`, so reading only the first word of it read a
 * five-deep semicolon-free body as flat.
 */
const CONTROL_TAIL = /\b(?:else|if|for|while|switch|catch|try|finally|do)\b[^{};]*$/
/** A header whose brace opens the body of an arrow function. */
const ARROW_BODY = /=>\s*$/

/** A header that opens a branch rather than a value: `if (…)`, `else`, `catch`. */
function isControlHeader(header: string): boolean {
  return CONTROL_HEADER.test(header.trimStart())
}

/** Whether a header ends in a control clause rather than in a value. */
function endsInControlClause(header: string): boolean {
  return CONTROL_TAIL.test(header.trimEnd())
}

/**
 * Whether the brace after `header` opens a nesting level: a control block or a
 * function body.
 *
 * An object literal, an object argument and a callback passed as an argument are
 * *data*; counting their braces made `rows.map(r => ({ … }))` nested five deep with
 * no branch anywhere in the function. A block-bodied callback is likewise a wrapper
 * around the code it runs rather than a branch of its own — five chained
 * `rows.forEach(row => { … })` calls are a pipeline, not five levels — so it counts
 * no level either, while control flow *inside* it still does. A counted brace and its
 * closing brace are tracked as a pair, so an uncounted literal cannot drive the depth
 * negative.
 */
function opensNestingLevel(header: string): boolean {
  if (header.length > 400) return false
  if (isControlHeader(header) || endsInControlClause(header)) return true
  if (!isFunctionHeader(header)) return false
  return !ARROW_BODY.test(header.trimEnd())
}

function maxBraceDepth(code: string, from: number, to: number): number {
  const counted: boolean[] = []
  let depth = 0
  let max = 0
  for (let index = from; index <= to && index < code.length; index += 1) {
    const char = code.charAt(index)
    if (char === '{') {
      // The brace at `from` opens the body being measured, so it is level one by
      // definition; every brace after it has to earn the level.
      const opens =
        index === from ||
        opensNestingLevel(
          code.slice(
            Math.max(
              code.lastIndexOf(';', index - 1),
              code.lastIndexOf('{', index - 1),
              code.lastIndexOf('}', index - 1),
            ) + 1,
            index,
          ),
        )
      counted.push(opens)
      if (opens) {
        depth += 1
        if (depth > max) max = depth
      }
    } else if (char === '}') {
      if (counted.pop() === true) depth -= 1
    }
  }
  return max
}

/**
 * Whether the text between the previous statement boundary and a `{` is a
 * function header rather than a control block or an object literal. `function f()`,
 * `f()`, `(a) =>`, and `f(): void` all count; `if (...)`, `else`, and `class A`
 * do not.
 */
function isFunctionHeader(header: string): boolean {
  let text = header.trimEnd()
  if (text.length === 0) return false
  // A return type sits between the parameter list and the brace.
  const annotation = /\)\s*:\s*[^{};]+$/.exec(text)
  if (annotation !== null) text = `${text.slice(0, annotation.index)})`
  if (text.endsWith('=>')) return true
  if (!text.endsWith(')')) return false

  let depth = 0
  let open = -1
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text.charAt(index)
    if (char === ')') depth += 1
    else if (char === '(') {
      depth -= 1
      if (depth === 0) {
        open = index
        break
      }
    }
  }
  if (open === -1) return false
  const beforeParen = text.slice(0, open)
  const word = /([A-Za-z_$][\w$]*)\s*\*?\s*$/.exec(beforeParen)
  // An anonymous function expression has no name to look at.
  if (word === null) return true
  return !CONTROL_KEYWORDS.has((word[1] as string).toLowerCase())
}

function jsFunctionSpans(code: string, newlines: readonly number[]): FunctionSpan[] {
  const spans: FunctionSpan[] = []
  let argumentDepth = 0
  for (let index = 0; index < code.length; index += 1) {
    const char = code.charAt(index)
    if (char === '(' || char === '[') {
      argumentDepth += 1
      continue
    }
    if (char === ')' || char === ']') {
      if (argumentDepth > 0) argumentDepth -= 1
      continue
    }
    if (char !== '{') continue
    // A brace inside an argument list is an object literal argument, not a
    // definition. Without this, `describe('x', () => { … })` and
    // `new Response(body, { … })` became "functions" that spanned a whole suite:
    // the statement boundary scan reaches back past statementless lines, so the
    // header absorbed whatever statements came before it.
    if (argumentDepth !== 0) continue
    const boundary = Math.max(
      code.lastIndexOf(';', index - 1),
      code.lastIndexOf('{', index - 1),
      code.lastIndexOf('}', index - 1),
    )
    const headerStart = boundary + 1
    if (index - headerStart > 400) continue
    const header = code.slice(headerStart, index)
    if (!isFunctionHeader(header)) continue
    const close = matchBrace(code, index)
    const bodyEnd = close === -1 ? code.length - 1 : close
    const firstChar = headerStart + (header.length - header.trimStart().length)
    spans.push({
      startLine: lineAt(newlines, firstChar),
      endLine: lineAt(newlines, close === -1 ? code.length : close),
      bodyStart: index,
      bodyEnd,
      nesting: Math.max(0, maxBraceDepth(code, index, bodyEnd) - 1),
    })
  }
  return spans
}

type PythonFunctionSpan = PlacedSpan & { name: string }

function pythonFunctionSpans(text: string): PythonFunctionSpan[] {
  const lines = text.split('\n')
  const spans: PythonFunctionSpan[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] as string
    const match = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/.exec(header)
    if (match === null) continue
    const baseIndent = (match[1] as string).length
    let end = index
    let maxIndent = baseIndent
    let unit = 0
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const body = lines[cursor] as string
      if (body.trim() === '') continue
      const indent = (/^[ \t]*/.exec(body) as RegExpExecArray)[0].length
      if (indent <= baseIndent) break
      end = cursor
      const delta = indent - baseIndent
      if (unit === 0 || delta < unit) unit = delta
      if (indent > maxIndent) maxIndent = indent
    }
    const step = unit > 0 ? unit : 4
    spans.push({
      startLine: index + 1,
      endLine: end + 1,
      name: match[2] as string,
      nesting: Math.round((maxIndent - baseIndent) / step),
    })
  }
  return spans
}

// --- rule: decision trace -------------------------------------------------

type DecisionPattern = { label: string; re: RegExp }

/**
 * The vocabulary of an explicit decision. `because`, `instead of` and the Chinese
 * equivalents are the load-bearing ones: they only appear when someone wrote down
 * *why*, which is the whole product.
 */
const DECISION_PATTERNS: readonly DecisionPattern[] = [
  { label: 'because', re: /because/i },
  { label: 'instead of', re: /instead of/i },
  { label: 'tradeoff', re: /trade-?offs?\b/i },
  { label: 'we chose', re: /we (?:chose|choose|picked)/i },
  { label: 'why not', re: /why not/i },
  { label: 'workaround', re: /work-?around/i },
  { label: 'deliberately', re: /deliberate(?:ly)?/i },
  { label: '因为', re: /因为/ },
  { label: '而不是', re: /而不是/ },
  { label: '权衡', re: /权衡/ },
  { label: '刻意', re: /刻意/ },
]

/**
 * The words a generator writes and a maintainer does not.
 *
 * A marker only means anything inside a banner (see `generatedBanner`), and `DO NOT
 * EDIT` has to be upper case: `// Do not edit this list; it is sorted` is a note about
 * the list, not about the file, and reading it as a banner silenced real code.
 */
const GENERATED_MARKERS: readonly RegExp[] = [
  /@generated\b/i,
  /auto-?generated\b/i,
  /\bcode generated\b[^\n]*\bDO NOT EDIT\b/,
  /\bDO NOT (?:EDIT|MODIFY)\b/,
]
/**
 * `generated by <name>`, where `<name>` has to look like a tool: a generator signs
 * with a package name (`prisma-client-js`), while `generated by hand from the spec` is
 * a person describing what they did.
 */
const GENERATED_BY = /\bgenerated by[ \t]+([A-Za-z0-9_@][\w.@/-]*)/i
const TOOL_NAME = /[0-9_.@/-]/

/** Whether the words of one banner comment announce a generator. */
function isGeneratedText(text: string): boolean {
  if (GENERATED_MARKERS.some((marker) => marker.test(text))) return true
  const by = GENERATED_BY.exec(text)
  if (by === null) return false
  return TOOL_NAME.test((by[1] as string).replace(/\.+$/, ''))
}

/**
 * Whether the file is generated, read from its banner alone.
 *
 * A generator writes its banner before anything else, so only the comments that come
 * before the first line of code are a banner — the leading run of blank lines and
 * comments — and a marker further down the file is just a comment. A marker this high
 * closes the whole file: Prisma, protoc and graphql-codegen output is full of
 * `interface …Cache`, `new Uint8Array` and hundred-line functions, which are the
 * highest-weight kinds, and nobody may read a line of it.
 */
function generatedBanner(scan: Scan, newlines: readonly number[]): boolean {
  const first = /\S/.exec(scan.code)
  const limit = first === null ? Number.POSITIVE_INFINITY : lineAt(newlines, first.index)
  return scan.comments.some(
    (comment) => comment.line < limit && isGeneratedText(comment.text),
  )
}

// --- rule: custom infrastructure -----------------------------------------

/**
 * What "a standard library already has this" looks like in a name.
 *
 * Matched per *word*, not against the raw name: `test_parse_rejects_empty`
 * normalizes to `testparsereject…`, which contains `parser`, and a rule that reads
 * names as one blob fires on a test function. Splitting on case and separators
 * keeps `createSerializer`, `StateMachine` and `state_machine` while dropping
 * that. The multi-word wheels are checked against the *joined* name instead,
 * because their halves are useless on their own — `machine` and `container` are
 * everywhere — and because case splitting hides them: `RateLimiter` yields `rate`
 * and `limiter`.
 */
const COMPOUND_INFRA: readonly string[] = [
  'statemachine',
  'fsm',
  'dicontainer',
  'virtualdom',
  'vdom',
  'ratelimit',
]

const TOKEN_INFRA: readonly string[] = [
  'scheduler',
  'dispatcher',
  'queue',
  'pool',
  'serializer',
  'deserializer',
  'parser',
  'injector',
  'lru',
  'cache',
  'interceptor',
  'middleware',
  'reconciler',
  'bundler',
  'buffer',
  'ring',
  'backoff',
  'debounce',
  'throttle',
  'semaphore',
  'breaker',
  'trie',
  'heap',
  'bus',
  'emitter',
]

/** `createScheduler` and `create_scheduler` both yield `['create', 'scheduler']`. */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase())
}

/** The wheel a declaration name names, or `null`. */
function infraWord(name: string): string | null {
  const joined = normalizeName(name)
  for (const keyword of COMPOUND_INFRA) {
    if (joined.includes(keyword)) return keyword
  }
  for (const token of nameTokens(name)) {
    for (const keyword of TOKEN_INFRA) {
      if (tokenNamesWheel(token, keyword)) return keyword
    }
  }
  return null
}

/**
 * Whether a lowered name token carries `keyword`.
 *
 * A token *is* the wheel, or — for a keyword long enough to be a word of its own —
 * the wheel plus a suffix, so `Debouncer` and `Serializer` still count. A short
 * keyword is only ever the whole token: matched as a substring, `ring` fired on
 * `asString` and on `Spring`, and `bus` on `busy`, all at weight 3.
 */
function tokenNamesWheel(token: string, keyword: string): boolean {
  return token === keyword || (keyword.length >= 5 && token.startsWith(keyword))
}

/**
 * Declarations that can carry behaviour. `interface`, `type`, `enum` and `namespace`
 * are left out on purpose: `export interface CacheEntry` declares a shape, not a
 * cache, and scoring it made `src/cache/types.ts` outrank the cache itself.
 */
const JS_DECLARATION = /(?:^|[^\w$.])(class|function|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/g
const PY_DECLARATION = /(?:^|[^\w.])(class|def)[ \t]+([A-Za-z_]\w*)/g
const VALUE_BINDINGS: ReadonlySet<string> = new Set(['const', 'let', 'var'])

/**
 * An initializer that *defines* code: a function or class expression, an arrow, or
 * an object literal. Deliberately excludes `new X(...)` and `createX(...)`: those
 * are calls into somebody else's implementation, which is the difference between
 * writing a cache and using one.
 */
const CODE_INITIALIZER = /^\s*(?:async\s+)?(?:function\b|class\b|\{|\(|[A-Za-z_$][\w$]*\s*=>)/

function definesCode(code: string, from: number): boolean {
  const rest = code.slice(from, Math.min(code.length, from + 400))
  const lineEnd = rest.indexOf('\n')
  const window = lineEnd === -1 ? rest : rest.slice(0, lineEnd)
  const equals = window.indexOf('=')
  if (equals === -1) return false
  return CODE_INITIALIZER.test(window.slice(equals + 1))
}

/**
 * Names this file borrowed from somewhere else, normalized.
 *
 * Read from the structure index when the file is indexed there, and from the
 * file's own import statements otherwise. The file's own basename is removed: a
 * module `src/queue.ts` that declares `class Queue` has not borrowed the name from
 * its specifier `./queue-helpers`, and suppressing it would lose exactly the file
 * the reader wants.
 */
function borrowedNames(
  file: CanonicalFile,
  family: Family,
  structure: StructureIndex,
  relativePath: string | null,
): Set<string> {
  const tokens = new Set<string>()
  const add = (token: string): void => {
    const normalized = normalizeName(token)
    if (normalized.length > 1) tokens.add(normalized)
  }
  const addSpecifier = (specifier: string): void => {
    for (const part of specifier.split(/[^A-Za-z0-9_$]+/)) add(part)
    add(specifier.slice(specifier.lastIndexOf('/') + 1).replace(/\.[A-Za-z]+$/, ''))
  }

  if (relativePath !== null) {
    const module = structure.modules.find((candidate) => candidate.path === relativePath)
    for (const edge of module?.imports ?? []) addSpecifier(edge.specifier)
  }

  for (const match of matches(file.text, /^[ \t]*(?:import|export)\b([^'"\n]*?)\bfrom[ \t]*['"]([^'"\n]+)['"]/gm)) {
    addSpecifier(match[2] as string)
    for (const token of (match[1] as string).split(/[^A-Za-z0-9_$]+/)) add(token)
  }
  for (const match of matches(file.text, /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm)) {
    addSpecifier(match[1] as string)
  }
  if (family === 'py') {
    for (const match of matches(file.text, /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([^\n]+)/gm)) {
      addSpecifier(match[1] as string)
      for (const token of (match[2] as string).split(/[^A-Za-z0-9_$]+/)) add(token)
    }
    for (const match of matches(file.text, /^[ \t]*import[ \t]+([\w.,\s]+)/gm)) {
      for (const token of (match[1] as string).split(/[^A-Za-z0-9_$]+/)) add(token)
    }
  }

  const own = (relativePath ?? file.path).slice((relativePath ?? file.path).lastIndexOf('/') + 1)
  tokens.delete(normalizeName(own.replace(/\.[A-Za-z]+$/, '')))
  return tokens
}

// --- rule: complexity -----------------------------------------------------

/**
 * Constructs that make a body hard rather than merely long. The list is short on
 * purpose: `Atomic`, `Mutex`, `RwLock` and `unsafe` only occur in the analysed
 * languages when a project wraps a real concurrency primitive, and a manual buffer
 * is spelled three or four ways at most.
 */
const DANGER_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'unsafe', re: /\bunsafe\b/g },
  { label: 'Atomic', re: /\bAtomic[A-Za-z]*\b/g },
  { label: 'Mutex', re: /\bMutex\b/g },
  { label: 'RwLock', re: /\bRwLock\b/g },
  { label: 'synchronized', re: /\bsynchronized\b/g },
  { label: 'buffer', re: /\bnew[ \t]+(?:Uint|Int)(?:8|16|32)Array[ \t]*\(/g },
  { label: 'buffer', re: /\bnew[ \t]+(?:ArrayBuffer|DataView)[ \t]*\(/g },
  { label: 'buffer', re: /\bBuffer[ \t]*\.[ \t]*allocUnsafe\b/g },
  { label: 'buffer', re: /\bmemcpy[ \t]*\(/g },
  { label: 'buffer', re: /\bmalloc[ \t]*\(/g },
  { label: 'buffer', re: /\breinterpret_cast\b/g },
]

// --- rule: test-spec ------------------------------------------------------

const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|specs?)\//i
const TEST_FILENAME = /(?:\.|[-_])(?:test|spec)\.[A-Za-z]+$/i
const PY_TEST_FILENAME = /(?:^|\/)test_[^/]*\.py$/i

/** A file is a test if its *path* says so; contents alone are not evidence. */
function isTestFile(filePath: string): boolean {
  const posix = filePath.split('\\').join('/')
  if (TEST_DIRECTORY.test(posix)) return true
  if (PY_TEST_FILENAME.test(posix)) return true
  return TEST_FILENAME.test(posix)
}

const ASSERTION = /\bexpect[ \t]*\(|\bassert\w*\b|\bt[ \t]*\.[ \t]*(?:is|deepEqual|not|throws|snapshot)\b/g
const FIXTURE_REFERENCE =
  /\b(?:fixtures?|beforeeach|beforeall|mkdtemp\w*|seedfixtures?|testfixtures?|createfixture\w*)\b/gi
const TEST_CALL = /^[ \t]*(?:it|test|specify)(?:\.\w+)*[ \t]*[(`]/gm

/** Index of the `(` that opens the call starting at `from`, or -1. */
function callParen(code: string, from: number): number {
  for (let index = from; index < code.length; index += 1) {
    const char = code.charAt(index)
    if (char === '(') return index
    if (char === '{' || char === '}' || char === ';') return -1
  }
  return -1
}

/**
 * The parenthesis of the call whose arguments contain `at`, or -1.
 *
 * Chained calls open one argument list per call: `it.each([[1, 2]])('adds',
 * () => { … })`. Only the last pair contains the callback, so the scan follows a
 * chain — a `(` that starts right after a closed `)` continues the same
 * expression — and gives up as soon as ordinary code appears between them, which
 * is what separates a chain from a second statement. Using the first `(` the call
 * name opened made every `it.each` form look like a declaration with no body,
 * losing the assertion density that makes a test file a specification.
 */
function enclosingCallParen(code: string, from: number, at: number): number {
  let depth = 0
  let last = -1
  let closedAt = -1
  for (let index = from; index < at; index += 1) {
    const char = code.charAt(index)
    if (char === '(') {
      if (depth === 0) {
        if (closedAt !== -1 && code.slice(closedAt + 1, index).trim() !== '') return -1
        last = index
      }
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        closedAt = index
        last = -1
      }
      continue
    }
    if (depth === 0 && (char === ';' || char === '{' || char === '}')) return -1
  }
  return depth > 0 ? last : -1
}

/** Whether the offset `at` still sits inside the argument list opened at `open`. */
function insideCallArguments(code: string, open: number, at: number): boolean {
  let depth = 0
  for (let index = open; index < at; index += 1) {
    const char = code.charAt(index)
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return false
    }
  }
  return depth > 0
}

// --- the scoring context --------------------------------------------------

type FileContext = {
  file: CanonicalFile
  family: Family
  scan: Scan
  lines: string[]
  newlines: number[]
  blocks: BlockSpan[]
  /** Every function or method span, computed once for complexity and grouping. */
  functions: PlacedSpan[]
  structure: StructureIndex
  relativePath: string | null
  borrowed: ReadonlySet<string>
}

type Hit = { kind: SignalKind; line: number; matched: string }

const hit = (kind: SignalKind, line: number, label: string): Hit => ({
  kind,
  line,
  matched: `${kind}:${label}`,
})

function decisionHits(context: FileContext): Hit[] {
  const hits: Hit[] = []
  const read = (span: Span): void => {
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.re.test(span.text)) hits.push(hit('decision-trace', span.line, pattern.label))
    }
  }
  for (const comment of context.scan.comments) {
    read(comment)
  }
  for (const literal of context.scan.strings) read(literal)
  return hits
}

function customInfraHits(context: FileContext): Hit[] {
  const hits: Hit[] = []
  const code = context.scan.code
  const pattern = context.family === 'js' ? JS_DECLARATION : PY_DECLARATION
  for (const match of matches(code, pattern)) {
    const keyword = (match[1] as string).toLowerCase()
    const name = match[2] as string
    const word = infraWord(name)
    if (word === null) continue
    if (context.borrowed.has(normalizeName(name))) continue
    if (VALUE_BINDINGS.has(keyword) && !definesCode(code, match.index + match[0].length)) continue
    hits.push(hit('custom-infra', lineAt(context.newlines, match.index + match[0].lastIndexOf(name)), word))
  }
  return hits
}

function complexityHits(context: FileContext): Hit[] {
  const hits: Hit[] = []
  const code = context.scan.code
  for (const span of context.functions) {
    if (span.endLine - span.startLine > LONG_FUNCTION_LINES) {
      hits.push(hit('complexity', span.startLine, 'long-function'))
    }
    if (span.nesting > DEEP_NESTING) hits.push(hit('complexity', span.startLine, 'deep-nesting'))
  }

  for (const pattern of DANGER_PATTERNS) {
    for (const match of matches(code, pattern.re)) {
      hits.push(hit('complexity', lineAt(context.newlines, match.index), pattern.label))
    }
  }
  return hits
}

function abstractionHits(context: FileContext): Hit[] {
  const hits: Hit[] = []
  const code = context.scan.code
  let abstractish = 0
  let concrete = 0

  if (context.family === 'js') {
    const interfaces = countMatches(code, /(?:^|[^\w$.])interface[ \t]+[A-Za-z_$][\w$]*/g)
    const abstractClasses = countMatches(code, /(?:^|[^\w$.])abstract[ \t]+class[ \t]+[A-Za-z_$][\w$]*/g)
    const classes = countMatches(code, /(?:^|[^\w$.])class[ \t]+[A-Za-z_$][\w$]*/g)
    abstractish = interfaces + abstractClasses
    concrete = Math.max(0, classes - abstractClasses)
  } else {
    const classes = countMatches(code, /^[ \t]*class[ \t]+[A-Za-z_]\w*/gm)
    const abstractClasses = countMatches(
      code,
      /^[ \t]*class[ \t]+[A-Za-z_]\w*[ \t]*\([ \t]*(?:abc\.|typing\.)?(?:ABC|Protocol)\b/gm,
    )
    abstractish = abstractClasses
    concrete = Math.max(0, classes - abstractClasses)
  }

  // A floor of two: one `interface Deps { … }` in a module with no classes is the
  // normal shape of typed TypeScript, not abstraction concentration. Measured on a
  // real repository, a bare `abstractish > concrete` fired on eight files whose
  // only type-level declaration was the deps interface of a single function.
  if (abstractish >= 2 && abstractish > concrete) {
    hits.push(hit('abstraction', 1, 'interfaces-outnumber-classes'))
  }

  const relativePath = context.relativePath
  if (relativePath !== null) {
    const self = context.structure.modules.find((candidate) => candidate.path === relativePath)
    if (self !== undefined && self.imports.length === 0) {
      const importers = context.structure.modules.filter(
        (candidate) =>
          candidate.path !== relativePath &&
          candidate.imports.some((edge) => edge.resolved === relativePath),
      ).length
      if (importers >= MIN_IMPORTERS) {
        hits.push(hit('abstraction', 1, `imported-by-${importers}-importing-nothing`))
      }
    }
  }
  return hits
}

const EVOLUTION =
  /\b(?:legacy|rewritten|deprecated|removed|superseded|migrat(?:e|es|ed|ing|ion)\w*)\b/gi

function evolutionLabel(word: string): string {
  const normalized = word.toLowerCase()
  return normalized.startsWith('migrat') ? 'migrate' : normalized
}

function evolutionHits(context: FileContext): Hit[] {
  const hits: Hit[] = []
  for (const comment of context.scan.comments) {
    for (const match of matches(comment.text, EVOLUTION)) {
      hits.push(hit('evolution', comment.line, evolutionLabel(match[0])))
    }
  }
  for (const match of matches(context.scan.code, EVOLUTION)) {
    hits.push(hit('evolution', lineAt(context.newlines, match.index), evolutionLabel(match[0])))
  }
  return hits
}

function testSpecHits(context: FileContext): Hit[] {
  if (!isTestFile(context.file.path)) return []
  const hits: Hit[] = []
  const code = context.scan.code

  const count = (body: string, line: number): void => {
    if (countMatches(body, ASSERTION) >= DENSE_ASSERTIONS) {
      hits.push(hit('test-spec', line, 'assertion-density'))
    }
    if (countMatches(body, FIXTURE_REFERENCE) >= FIXTURE_REFERENCES) {
      hits.push(hit('test-spec', line, 'fixture-heavy'))
    }
  }

  if (context.family === 'py') {
    for (const span of context.functions) {
      if (span.name === undefined || !span.name.startsWith('test_')) continue
      count(context.lines.slice(span.startLine - 1, span.endLine).join('\n'), span.startLine)
    }
    return hits
  }

  for (const match of matches(code, TEST_CALL)) {
    const line = lineAt(context.newlines, match.index)
    // The `{` of a callback body sits inside the call's own parentheses, whether it
    // opens on the call's line or a later one. A brace *after* the parentheses closes
    // belongs to somebody else: `it.todo('x')` above a dense `it('y', () => { … })`
    // used to read that test's assertions as its own.
    const open = code.indexOf('{', match.index)
    const paren = enclosingCallParen(code, match.index, open === -1 ? match.index : open)
    if (open !== -1 && paren !== -1 && insideCallArguments(code, paren, open)) {
      const close = matchBrace(code, open)
      count(code.slice(match.index, close === -1 ? code.length : close + 1), line)
      continue
    }
    // A call with no body is a declaration, not a specification; the only lines it
    // owns are its own.
    count(context.lines[line - 1] ?? '', line)
  }
  return hits
}

// --- assembly -------------------------------------------------------------

function compareHits(a: Hit, b: Hit): number {
  if (a.line !== b.line) return a.line - b.line
  const rank = (KIND_RANK.get(a.kind) as number) - (KIND_RANK.get(b.kind) as number)
  return rank !== 0 ? rank : byCodeUnit(a.matched, b.matched)
}

/**
 * The path of `file` inside the tree the structure index describes, or `null`.
 *
 * `canonicalizeFile` hands back the absolute path it was given, while the index
 * speaks in scope-relative paths, and this is the only place the two meet. The
 * longest suffix wins: with two modules whose paths suffix-match, the more specific
 * one is the one the file actually is.
 */
function relativePathOf(filePath: string, structure: StructureIndex): string | null {
  const normalized = filePath.split('\\').join('/')
  let best: string | null = null
  for (const module of structure.modules) {
    if (normalized !== module.path && !normalized.endsWith(`/${module.path}`)) continue
    if (best === null || module.path.length > best.length) best = module.path
  }
  return best
}

type HitGroup = { entries: Hit[]; line: number }

/** Index of the innermost function span containing `line`, or -1. */
function functionAt(functions: readonly PlacedSpan[], line: number): number {
  let best = -1
  for (let index = 0; index < functions.length; index += 1) {
    const span = functions[index] as PlacedSpan
    if (line < span.startLine || line > span.endLine) continue
    if (best === -1 || span.startLine >= (functions[best] as PlacedSpan).startLine) best = index
  }
  return best
}

/** Index of the first function span that starts at or after `line`, or -1. */
function functionAfter(functions: readonly PlacedSpan[], line: number): number {
  let best = -1
  for (let index = 0; index < functions.length; index += 1) {
    const span = functions[index] as PlacedSpan
    if (span.startLine < line) continue
    if (best === -1 || span.startLine < (functions[best] as PlacedSpan).startLine) best = index
  }
  return best
}

/**
 * The groups one block of hits is shown as.
 *
 * The unit is the innermost function: a 500-line class is not one finding, it is
 * the three methods that are hard, and a top-level `namespace N { … }` or an IIFE
 * must not turn a whole file into "look at line 1". A function that is itself
 * enormous is cut into per-bucket groups, and a container-level hit (the class
 * header, a comment above the class) joins the first function that follows it.
 */
function groupHits(
  entries: Hit[],
  block: BlockSpan | null,
  functions: readonly PlacedSpan[],
): HitGroup[] {
  const anchor = block === null ? 1 : block.startLine
  const lines = entries.map((entry) => entry.line)
  const span =
    block === null ? Math.max(...lines) - Math.min(...lines) : block.endLine - block.startLine
  const anchored = new Set(
    entries.map((entry) => functionAt(functions, entry.line)).filter((index) => index >= 0),
  )
  if (span <= GROUP_MAX_LINES && anchored.size <= 1) {
    return [{ entries, line: Math.min(...lines) }]
  }

  const groups = new Map<string, HitGroup>()
  for (const entry of entries) {
    const inside = functionAt(functions, entry.line)
    const owner = inside >= 0 ? inside : functionAfter(functions, entry.line)
    const start = owner >= 0 ? (functions[owner] as PlacedSpan).startLine : anchor
    const bucket = Math.max(0, Math.floor((entry.line - start) / BUCKET_LINES))
    const line = bucket === 0 && owner >= 0 ? start : entry.line
    const key = `${owner}:${bucket}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { entries: [entry], line })
    else {
      group.entries.push(entry)
      group.line = Math.min(group.line, line)
    }
  }
  return [...groups.values()]
}

function scoreHits(
  filePath: string,
  hits: readonly Hit[],
  blocks: readonly BlockSpan[],
  functions: readonly PlacedSpan[],
): Candidate[] {
  const unique: Hit[] = []
  const seen = new Set<string>()
  for (const entry of hits) {
    const key = `${entry.kind}|${entry.line}|${entry.matched}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }

  const byBlock = new Map<number, Hit[]>()
  for (const entry of unique) {
    const index = blockIndexAt(blocks, entry.line)
    const group = byBlock.get(index)
    if (group === undefined) byBlock.set(index, [entry])
    else group.push(entry)
  }

  const groups: HitGroup[] = []
  for (const [index, entries] of byBlock) {
    groups.push(
      ...groupHits(entries, index === -1 ? null : (blocks[index] as BlockSpan), functions),
    )
  }

  const candidates: Candidate[] = []
  for (const group of groups) {
    group.entries.sort(compareHits)
    const kinds = new Set<SignalKind>()
    let score = 0
    for (const entry of group.entries) {
      if (kinds.has(entry.kind)) continue
      kinds.add(entry.kind)
      score += SIGNAL_WEIGHTS[entry.kind]
    }
    // The kind reported is the most valuable one that fired; on a tie the earliest
    // hit wins, because that is where a reader would start reading.
    const topWeight = Math.max(...[...kinds].map((kind) => SIGNAL_WEIGHTS[kind]))
    const primary = group.entries.find(
      (entry) => SIGNAL_WEIGHTS[entry.kind] === topWeight,
    ) as Hit
    const line = group.line
    candidates.push({
      id: `${filePath}:${line}:${primary.kind}`,
      path: filePath,
      line,
      kind: primary.kind,
      score,
      // Labels repeat when the same rule fires several times inside one block; the
      // reader is told which rules fired, not how many times.
      matched: [...new Set(group.entries.map((entry) => entry.matched))],
    })
  }

  candidates.sort((a, b) => a.line - b.line || (KIND_RANK.get(a.kind) as number) - (KIND_RANK.get(b.kind) as number))
  return candidates
}

function contextOf(file: CanonicalFile, structure: StructureIndex): FileContext | null {
  const family = familyOf(file.path)
  if (family === null) return null
  if (file.text.trim() === '') return null
  const scan = scanSource(file.text, family)
  const newlines = newlineOffsets(file.text)
  // A generated file's body is a generator's shape, not this project's design: the
  // body of a Prisma or protoc client is the highest-weight kinds and nobody reads it.
  // The banner is the only evidence, and it speaks for the whole file.
  if (generatedBanner(scan, newlines)) return null
  const relativePath = relativePathOf(file.path, structure)
  return {
    file,
    family,
    scan,
    lines: file.text.split('\n'),
    newlines,
    blocks: family === 'js' ? jsBlocks(scan.code) : pyBlocks(file.text),
    functions: family === 'js' ? jsFunctionSpans(scan.code, newlines) : pythonFunctionSpans(file.text),
    structure,
    relativePath,
    borrowed: borrowedNames(file, family, structure, relativePath),
  }
}

/**
 * Every candidate one file produces. Pure: same file, same index, same output, no
 * I/O and no mutation, so each rule can be tested on a string.
 */
export function scoreFile(file: CanonicalFile, structure: StructureIndex): Candidate[] {
  const context = contextOf(file, structure)
  if (context === null) return []

  const hits: Hit[] = [
    ...decisionHits(context),
    ...customInfraHits(context),
    ...complexityHits(context),
    ...abstractionHits(context),
    ...evolutionHits(context),
    ...testSpecHits(context),
  ]
  return scoreHits(file.path, hits, context.blocks, context.functions)
}

// --- collection -----------------------------------------------------------

const READ_CONCURRENCY = 8

function resolveTopK(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_TOP_K
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_TOP_K
  return Math.floor(requested)
}

/**
 * Scores every file in `scope` and returns the `topK` most promising candidates.
 *
 * Paths are the scope's own (relative, posix) paths, because that is what a reader
 * is shown and what evidence is validated against. A file that cannot be read any
 * more is skipped rather than fatal: a scan of a live checkout must not die because
 * a build ran underneath it.
 */
export async function collectSignals(
  root: string,
  scope: Scope,
  structure: StructureIndex,
  opts?: { topK?: number },
): Promise<Candidate[]> {
  const rootAbs = path.resolve(root)
  const topK = resolveTopK(opts?.topK)
  const entries: ScopeFile[] = scope.files.filter((file) => familyOf(file.path) !== null)
  const perFile: Candidate[][] = entries.map(() => [])

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= entries.length) return
      const entry = entries[index] as ScopeFile
      try {
        const canonical = await canonicalizeFile(path.join(rootAbs, entry.path))
        perFile[index] = scoreFile(canonical, structure).map((candidate) => ({
          ...candidate,
          path: entry.path,
          id: `${entry.path}:${candidate.line}:${candidate.kind}`,
        }))
      } catch {
        perFile[index] = []
      }
    }
  }

  const workers = Math.min(READ_CONCURRENCY, entries.length)
  await Promise.all(Array.from({ length: workers }, worker))

  return perFile
    .flat()
    .sort(
      (a, b) =>
        b.score - a.score ||
        byCodeUnit(a.path, b.path) ||
        a.line - b.line ||
        (KIND_RANK.get(a.kind) as number) - (KIND_RANK.get(b.kind) as number),
    )
    .slice(0, topK)
}
