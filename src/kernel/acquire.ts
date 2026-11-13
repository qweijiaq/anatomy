/**
 * Acquisition: turn a user-supplied reference into bytes anatomy may read.
 *
 * Two constraints shape everything here.
 *
 * 1. `git clone` is not an option. On the machine this was built for a clone
 *    from github.com hangs for minutes, while the codeload tarball for the same
 *    commit arrives in under a second. So the module never shells out to `git`;
 *    a GitHub reference becomes a tarball URL, and `fetch` is the only way out.
 * 2. The repository is hostile input. Its code is never executed — no install,
 *    no setup, no tests — and its archive is never handed to a system `tar`.
 *    `extractTarSafe` parses the 512-byte headers itself so every entry can be
 *    refused by name before a single byte lands on disk.
 *
 * `extractTarSafe` validates the whole archive into a plan first and only then
 * writes, so a rejected archive leaves the destination empty rather than
 * half-extracted. Files are checked three ways: not absolute, no `..` segment,
 * and the resolved path still under the destination (the third check is what
 * catches platform-specific spellings the first two miss). Symlinks, hard
 * links, devices and fifos are refused outright: each is a way for an archive
 * to make a later entry write somewhere else.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { selectScope } from './scope.js'

/** The global `fetch`, injectable so tests never touch the network. */
export type FetchLike = typeof fetch

/**
 * Ceiling on the bytes one archive may cost: the download, the raw file, and
 * the inflated output are each bounded by it. 512 MiB is far above any source
 * tree anatomy is meant to read and far below what would exhaust the process,
 * which is the point: a few-KB gzip bomb must fail, not allocate.
 */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

export type AcquireDeps = {
  fetchImpl?: FetchLike
  /** Only for the `HEAD@<date>` fallback; injected so tests are deterministic. */
  now?: () => Date
  /** Archive byte ceiling for `downloadArchive`. Defaults to 512 MiB. */
  maxBytes?: number
}

export type ResolvedSource = {
  kind: 'archive' | 'local'
  /** Tarball to download. Absent for `local`. */
  url?: string
  /** Directory to read in place. Absent for `archive`. */
  path?: string
  /** Release tag, branch, or `HEAD@<YYYY-MM-DD>` when nothing could be resolved. */
  ref: string
  /** sha256 of the archive bytes (after download) or of the tree contents (local). */
  sha: string
  /** Repository-relative subdirectory the user pointed at, or ''. */
  subpath: string
}

// --- source resolution ----------------------------------------------------

const GITHUB_HOST = /^(?:https?:\/\/)?(?:www\.)?github\.com\//

const GITHUB_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+)(?:\/(.+?))?)?\/?$/

type GithubRef = { owner: string; repo: string; ref?: string; subpath: string }

function parseGithubUrl(input: string): GithubRef | null {
  const match = GITHUB_URL.exec(input)
  if (match === null) return null
  const owner = match[1] as string
  const repo = (match[2] as string).replace(/\.git$/, '')
  const ref = match[3]
  const subpath = (match[4] ?? '').replace(/^\/+|\/+$/g, '')
  return { owner, repo, ...(ref === undefined ? {} : { ref }), subpath }
}

const codeloadUrl = (owner: string, repo: string, ref: string): string =>
  `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`

const isoDate = (date: Date): string => date.toISOString().slice(0, 10)

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * The latest release, or `null` for every failure mode that should fall back to
 * the default branch: offline, rate limited, no releases, unparseable payload.
 */
async function latestRelease(
  owner: string,
  repo: string,
  fetchImpl: FetchLike,
): Promise<{ ref: string; url: string } | null> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { tag_name?: unknown; tarball_url?: unknown }
    if (typeof body.tag_name !== 'string' || body.tag_name === '') return null
    const url =
      typeof body.tarball_url === 'string' && body.tarball_url !== ''
        ? body.tarball_url
        : codeloadUrl(owner, repo, body.tag_name)
    return { ref: body.tag_name, url }
  } catch {
    return null
  }
}

/**
 * Classifies `input` and works out what to download.
 *
 * Ref precedence: an explicit `opts.ref`, then a `/tree/<ref>` in the URL, then
 * the latest release tag, then the default branch as `HEAD@<YYYY-MM-DD>`.
 *
 * `sha` is empty for `archive` sources: the archive does not exist yet, so its
 * digest is only knowable once `downloadArchive` has fetched it.
 */
export async function resolveSource(
  input: string,
  opts: { ref?: string } = {},
  deps: AcquireDeps = {},
): Promise<ResolvedSource> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('anatomy: empty source reference')

  const fallbackRef = `HEAD@${isoDate(deps.now?.() ?? new Date())}`
  const github = parseGithubUrl(trimmed)

  if (github === null && GITHUB_HOST.test(trimmed)) {
    // github.com also hosts issues, pull requests and file views; treating
    // those as tarball URLs would download an HTML page and call it a source.
    throw new Error(
      `anatomy: cannot parse GitHub URL "${trimmed}" (accepted forms: ` +
        'https://github.com/<owner>/<repo> and ' +
        'https://github.com/<owner>/<repo>/tree/<ref>/<path>)',
    )
  }

  if (github !== null) {
    const { owner, repo, subpath } = github
    const explicit = opts.ref ?? github.ref
    if (explicit !== undefined) {
      return {
        kind: 'archive',
        url: codeloadUrl(owner, repo, explicit),
        ref: explicit,
        sha: '',
        subpath,
      }
    }
    const release = await latestRelease(owner, repo, fetchImpl)
    if (release !== null) {
      return { kind: 'archive', url: release.url, ref: release.ref, sha: '', subpath }
    }
    return {
      kind: 'archive',
      url: codeloadUrl(owner, repo, 'HEAD'),
      ref: fallbackRef,
      sha: '',
      subpath,
    }
  }

  if (/^https?:\/\//.test(trimmed)) {
    return { kind: 'archive', url: trimmed, ref: opts.ref ?? fallbackRef, sha: '', subpath: '' }
  }

  const absolute = path.resolve(trimmed)
  let info
  try {
    info = await stat(absolute)
  } catch {
    info = null
  }
  if (info !== null && info.isDirectory()) {
    return {
      kind: 'local',
      path: absolute,
      // A directory has no commit to name, and a date here would mint a new run
      // id every midnight for byte-identical input: 'local' is constant.
      ref: opts.ref ?? 'local',
      sha: await hashTree(absolute),
      subpath: '',
    }
  }

  throw new Error(
    `anatomy: cannot resolve source "${input}" (expected a GitHub URL, a tarball URL, or a directory)`,
  )
}

/**
 * Turn in-archive symlinks into files, or refuse them.
 *
 * A link is followed only when it resolves — relative to the link's own directory —
 * to a regular file that the same archive contains, after normalisation. That is
 * what a release tarball's `LICENSE -> packages/core/LICENSE` needs. Everything
 * else stays refused: a link out of the archive, a link to a directory, a chain, a
 * cycle, or an absolute target. Following links blindly is how an archive escapes
 * its extraction directory, so the rule stays "the bytes must already be here".
 */
function resolveSymlinks(plan: PlannedEntry[], root: string): PlannedEntry[] {
  const regular = new Set(
    plan.filter((entry): entry is Extract<PlannedEntry, { kind: 'file' }> => entry.kind === 'file')
      .map((entry) => entry.name),
  )
  const out: PlannedEntry[] = []
  for (const entry of plan) {
    if (entry.kind !== 'symlink') {
      out.push(entry)
      continue
    }
    if (path.isAbsolute(entry.linkTo)) throw unsafe(entry.name, 'symbolic link to an absolute path')
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(entry.name), entry.linkTo),
    )
    if (resolved.startsWith('..')) throw unsafe(entry.name, 'symbolic link outside the archive')
    // A link to something the archive does not carry is *skipped*, not fatal: real
    // repositories ship links to generated binaries (`chroma` has
    // `bin/binaryen-unittests`), and refusing the whole archive over one meant the
    // project could not be analysed at all. The link is never followed, so nothing
    // outside the archive can enter; it simply yields no file.
    if (!regular.has(resolved)) continue
    const source = plan.find(
      (candidate): candidate is Extract<PlannedEntry, { kind: 'file' }> =>
        candidate.kind === 'file' && candidate.name === resolved,
    )
    if (source === undefined) throw unsafe(entry.name, 'symbolic link to a file the archive lacks')
    out.push({ kind: 'file', name: entry.name, target: entry.target, data: source.data })
  }
  return out
}

/**
 * Domain tag in front of the tree digest, so it is never mistaken for a digest of
 * something else and an all-excluded tree is not `sha256("")`.
 */
const TREE_DIGEST_DOMAIN = 'anatomy-tree-v2\0'

/**
 * sha256 over a domain tag and the tree's contents: per regular file,
 * `path\0len\0content`, files walked in sorted path order.
 *
 * The tag (`anatomy-tree-v2\0`, see above) is fed before the first file: a tree
 * whose every file is excluded used to digest to `sha256("")`, the same value as
 * an empty tree and as any unrelated hash of nothing. Content, not shape — two
 * trees whose files merely have the same lengths (`const a = 1` rewritten as
 * `const a = 2`) are different snapshots, and reusing the previous run's
 * artifacts for them is silently wrong. Files are streamed, so one large file is
 * not read into memory. A symlink is deliberately not followed: it can point out
 * of the tree.
 *
 * `IGNORED_DIRECTORIES` is the analysis scope's own exclusion list: `.git`
 * bookkeeping and dependency/build output move on every checkout without changing
 * one byte the analysis reads, and a digest that moves with them mints a new
 * `runId` for an identical analysis.
 */
async function hashTree(root: string): Promise<string> {
  // The digest covers what the analysis reads, which is exactly the scope — so a
  // gitignored local cache or a build directory cannot move the runId. Hashing
  // the raw directory instead made two identical analyses land in two runs.
  const scope = await selectScope(root, {
    limits: {
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: Number.MAX_SAFE_INTEGER,
      maxLines: Number.MAX_SAFE_INTEGER,
    },
  })

  const digest = createHash('sha256')
  digest.update(TREE_DIGEST_DOMAIN)
  for (const file of [...scope.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const absolute = path.join(root, file.path)
    digest.update(`${file.path}\0${file.bytes}\0`)
    for await (const chunk of createReadStream(absolute)) {
      digest.update(chunk as Buffer)
    }
  }
  return digest.digest('hex')
}

/**
 * Reads a response body, refusing rather than buffering once it passes `max`.
 *
 * Both the declared `content-length` and the bytes actually arriving are
 * checked: a server may declare nothing, or lie about what it declares, so the
 * only trustworthy number is the running total.
 */
async function readBoundedBody(
  response: Response,
  max: number,
  what: 'download' | 'decompressed archive',
): Promise<Buffer> {
  const limit = `anatomy: ${what} exceeds the ${max}-byte limit`
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > max) throw new Error(limit)

  const body = response.body as unknown as AsyncIterable<Uint8Array> | null
  if (body === null) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > max) throw new Error(limit)
    return bytes
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.length
    if (total > max) throw new Error(limit)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Fetches the tarball `source` points at and returns the digest of what arrived. */
export async function downloadArchive(
  source: ResolvedSource,
  destFile: string,
  deps: AcquireDeps = {},
): Promise<{ sha: string; bytes: number }> {
  if (source.kind !== 'archive' || source.url === undefined) {
    throw new Error('anatomy: downloadArchive needs an archive source with a url')
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(source.url)
  if (!response.ok) {
    throw new Error(`anatomy: download failed (${response.status}) for ${source.url}`)
  }
  const bytes = await readBoundedBody(response, deps.maxBytes ?? DEFAULT_MAX_BYTES, 'download')
  await mkdir(path.dirname(destFile), { recursive: true })
  await writeFile(destFile, bytes)
  return { sha: sha256(bytes), bytes: bytes.length }
}

// --- run identity ---------------------------------------------------------

/** JSON with object keys sorted at every level, so the digest is key-order blind. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Identity of one analysis.
 *
 * The tree digest, ref, subpath and engine version say *what was analysed*; they
 * are what makes two scans comparable. They are deliberately not the whole id:
 * with only those, a second scan of the same commit reopened the first run's
 * directory and overwrote its report, so a person who ran the same repository
 * twice could not get back to what the model wrote the first time. That is the
 * opposite of what a history list promises.
 *
 * So `nonce` — one per invocation — is part of the id. The cost is that `sha`
 * alone no longer identifies a directory; the benefit is that every run is
 * addressable. Callers who need "the latest run of this tree" filter the list by
 * `sha`, which is recorded in the manifest anyway.
 *
 * `sha` must be the digest of the downloaded archive or of the local tree as
 * `hashTree` computes it — domain-tagged, so a tree whose every file was excluded
 * does not collapse into `sha256("")`. An empty one would give every archive
 * source the same run directory, so it is refused instead of silently aliasing
 * snapshots together.
 */
export function deriveRunId(input: {
  sha: string
  ref: string
  subpath: string
  engineVersion: string
  /** Distinguishes two runs of the same tree. Omitted only by tests that want a stable id. */
  nonce?: string
}): string {
  if (input.sha === '') throw new Error('anatomy: run id needs the downloaded sha')
  return sha256(stableJson({ ...input, nonce: input.nonce ?? '' })).slice(0, 12)
}

/**
 * A sortable, collision-free nonce for one analysis.
 *
 * Time first so run ids group chronologically in a directory listing, then
 * randomness because two analyses can start inside the same millisecond — a
 * double-click on "开始拆解" must not reopen the first one.
 */
export function runNonce(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

// --- safe extraction ------------------------------------------------------

const BLOCK = 512
/** ustar stores paths over 100 bytes as `prefix` + '/' + `name`. */
const MAGIC_START = 257
const LINK_START = 157
const LINK_LENGTH = 100
const PREFIX_START = 345
const PREFIX_LENGTH = 155

type PlannedEntry =
  | { kind: 'file'; name: string; target: string; data: Buffer }
  | { kind: 'dir'; name: string; target: string }
  /**
   * A link inside the archive, resolved after every entry is known.
   *
   * Repositories really do contain these: `clack` ships `LICENSE -> packages/core/LICENSE`,
   * which a release tarball stores as a symlink. Refusing the whole archive over it
   * made a real project unanalysable; creating it blindly is how an archive escapes
   * its directory. The honest middle is to follow the link only when it points at a
   * regular file that the archive itself contains.
   */
  | { kind: 'symlink'; name: string; target: string; linkTo: string }

const unsafe = (name: string, reason: string): Error =>
  new Error(`anatomy: unsafe entry: ${name} (${reason})`)

/**
 * Extracts `archivePath` (gzip or plain tar) into `destDir`, refusing the whole
 * archive if any entry could write outside it.
 *
 * The archive is parsed and validated into a plan before the first write, so a
 * rejection leaves `destDir` empty even when the offending entry comes last.
 * Every byte that arrives is bounded by `opts.maxBytes` (raw input, inflated
 * output), and `destDir` itself must be empty: a run directory is only ever
 * extracted into once, and leftovers from an earlier attempt would mix two
 * trees into one run.
 */
export async function extractTarSafe(
  archivePath: string,
  destDir: string,
  opts: { maxBytes?: number } = {},
): Promise<{ entries: number; bytes: number }> {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const raw = await readFile(archivePath)
  if (raw.length > max) throw new Error(`anatomy: archive input exceeds the ${max}-byte limit`)
  const bytes = isGzip(raw) ? inflate(raw, max) : raw

  const root = path.resolve(destDir)
  await mkdir(root, { recursive: true })
  if ((await readdir(root)).length > 0) throw new Error('anatomy: destination is not empty')

  const plan = planEntries(bytes, root)
  let written = 0
  for (const entry of plan) {
    if (entry.kind === 'dir') {
      await mkdir(entry.target, { recursive: true })
      continue
    }
    // `resolveSymlinks` has already turned every acceptable link into a file, so a
    // symlink cannot reach this loop; the guard keeps the type honest.
    if (entry.kind === 'symlink') throw unsafe(entry.name, 'symbolic link')
    await mkdir(path.dirname(entry.target), { recursive: true })
    await writeFile(entry.target, entry.data)
    written += entry.data.length
  }
  return { entries: plan.length, bytes: written }
}

/** `gunzipSync` with an output ceiling, so a bomb fails instead of allocating. */
function inflate(raw: Buffer, max: number): Buffer {
  try {
    return gunzipSync(raw, { maxOutputLength: max })
  } catch (error) {
    const tooLarge =
      error instanceof RangeError || (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
    if (!tooLarge) throw error
    throw new Error(`anatomy: decompressed archive exceeds the ${max}-byte limit`)
  }
}

const isGzip = (bytes: Buffer): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0)

/** NUL-terminated string field, trailing padding dropped. */
function field(buffer: Buffer): string {
  const text = buffer.toString('utf8')
  const end = text.indexOf('\0')
  return end === -1 ? text : text.slice(0, end)
}

function readSize(header: Buffer): number {
  const first = header[124] ?? 0
  if ((first & 0x80) !== 0) {
    throw new Error('anatomy: tar header uses base-256 sizes, which are not supported')
  }
  const text = header.toString('latin1', 124, 136).replace(/\0.*$/, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`anatomy: malformed tar size field "${text}"`)
  return Number.parseInt(text, 8)
}

/** `prefix/name` for ustar headers, plain `name` otherwise. */
function entryName(header: Buffer): string {
  const name = field(header.subarray(0, 100))
  const magic = header.toString('latin1', MAGIC_START, MAGIC_START + 5)
  if (magic !== 'ustar') return name
  const prefix = field(header.subarray(PREFIX_START, PREFIX_START + PREFIX_LENGTH))
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * pax extended header payload -> its records (`"<length> <key>=<value>\n"` per
 * record, `<length>` counting the whole record). `path` and `size` are the two
 * the extractor honours; the rest are carried so they can be refused by name.
 */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let rest = body.toString('utf8')
  while (rest.length > 0) {
    const space = rest.indexOf(' ')
    if (space === -1) break
    const length = Number.parseInt(rest.slice(0, space), 10)
    if (!Number.isFinite(length) || length <= 0 || length > rest.length) break
    const record = rest.slice(space + 1, length - 1) // drop the trailing \n
    const equals = record.indexOf('=')
    if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1))
    rest = rest.slice(length)
  }
  return records
}

/**
 * Absolute target for an entry, or `unsafe entry` when the name could escape.
 *
 * `'..'` is looked for in backslash-separated names too: on this platform a
 * backslash is a legal filename byte, but the archive may be inspected on a
 * platform where it is not.
 */
function safeTarget(name: string, root: string): string {
  if (name === '') throw unsafe(name, 'empty name')
  if (name.includes('\0')) throw unsafe(name, 'NUL byte in name')
  if (path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) throw unsafe(name, 'absolute path')
  if (name.split(/[\\/]/).includes('..')) throw unsafe(name, 'path traversal')
  const target = path.resolve(root, name)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw unsafe(name, 'resolves outside the destination')
  }
  return target
}

/** Parses and validates every entry. Nothing is written here. */
function planEntries(bytes: Buffer, root: string): PlannedEntry[] {
  const plan: PlannedEntry[] = []
  /** Set by a GNU `L` entry or a pax `path` record; applies to the next entry. */
  let overrideName: string | null = null
  /** Set by a pax `size` record: some archivers leave the header size at 0. */
  let overrideSize: number | null = null
  /** A well-formed archive ends with two zero blocks; without them it is cut. */
  let terminated = false
  let offset = 0

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) {
      const second = bytes.subarray(offset + BLOCK, offset + 2 * BLOCK)
      if (second.length < BLOCK || !isZeroBlock(second)) {
        throw new Error('anatomy: truncated tar archive')
      }
      terminated = true
      break
    }

    const typeflag = String.fromCharCode(header[156] ?? 0)
    const metadata = typeflag === 'L' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g'
    // Metadata headers carry their own payload; only a real entry takes the
    // size a preceding pax record announced.
    const size = metadata ? readSize(header) : (overrideSize ?? readSize(header))

    const bodyStart = offset + BLOCK
    const bodyEnd = bodyStart + size
    if (bodyEnd > bytes.length) throw new Error('anatomy: truncated tar archive')
    const body = bytes.subarray(bodyStart, bodyEnd)
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK

    // Metadata entries describe the next real entry; they are never extracted.
    if (typeflag === 'L') {
      overrideName = field(body)
      continue
    }
    if (typeflag === 'K') continue // long link name: the link itself is refused below
    if (typeflag === 'x' || typeflag === 'g') {
      const records = paxRecords(body)
      for (const key of records.keys()) {
        // A sparse entry stores its holes as metadata and only the data blocks
        // in the body, so it would be written as a short, silently wrong file.
        if (key.startsWith('GNU.sparse.')) {
          throw new Error('anatomy: sparse tar entries are not supported')
        }
      }
      if (typeflag === 'x') {
        const paxName = records.get('path')
        if (paxName !== undefined) overrideName = paxName
        const paxSize = records.get('size')
        if (paxSize !== undefined) {
          if (!/^[0-9]+$/.test(paxSize)) {
            throw new Error(`anatomy: malformed pax size record "${paxSize}"`)
          }
          overrideSize = Number.parseInt(paxSize, 10)
        }
      }
      continue
    }

    const headerName = overrideName ?? entryName(header)
    overrideName = null
    overrideSize = null
    // `tar -cf x.tar .` starts with an entry named './' naming the destination
    // itself: strip the prefix, and skip what strips down to nothing.
    const name = headerName.startsWith('./') ? headerName.slice(2) : headerName
    if (name === '' || name === '.') continue
    const target = safeTarget(name, root)

    if (typeflag === '5') {
      plan.push({ kind: 'dir', name, target })
      continue
    }
    if (typeflag === '\0' || typeflag === '0' || typeflag === '7') {
      plan.push({ kind: 'file', name, target, data: Buffer.from(body) })
      continue
    }
    if (typeflag === '2') {
      // The link target is read now and resolved by `resolveSymlinks` once every
      // member is known: a link to a file the archive does not contain is a way out.
      const linkTo = field(header.subarray(LINK_START, LINK_START + LINK_LENGTH))
      if (linkTo.trim() === '') throw unsafe(name, 'symbolic link with no target')
      plan.push({ kind: 'symlink', name, target, linkTo })
      continue
    }
    const reason =
      typeflag === '1'
        ? 'hard link'
        : typeflag === '3' || typeflag === '4'
          ? 'device node'
          : typeflag === '6'
            ? 'fifo'
            : `unsupported typeflag "${typeflag}"`
    throw unsafe(name, reason)
  }

  if (!terminated) throw new Error('anatomy: truncated tar archive')
  if (plan.length === 0) throw new Error('anatomy: tar archive contains no entries')
  return resolveSymlinks(plan, root)
}
