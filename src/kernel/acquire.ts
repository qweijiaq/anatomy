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

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

/** The global `fetch`, injectable so tests never touch the network. */
export type FetchLike = typeof fetch

export type AcquireDeps = {
  fetchImpl?: FetchLike
  /** Only for the `HEAD@<date>` fallback; injected so tests are deterministic. */
  now?: () => Date
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
      ref: opts.ref ?? fallbackRef,
      sha: await hashTree(absolute),
      subpath: '',
    }
  }

  throw new Error(
    `anatomy: cannot resolve source "${input}" (expected a GitHub URL, a tarball URL, or a directory)`,
  )
}

/**
 * sha256 over the tree's shape: every regular file's repo-relative path and
 * size, sorted. Content hashes would be stronger but cost a read per file;
 * paths plus sizes already change whenever the tree changes meaningfully, and a
 * symlink is deliberately not followed (it can point out of the tree).
 */
async function hashTree(root: string): Promise<string> {
  const lines: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const dirents = await readdir(dir, { withFileTypes: true })
    for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, dirent.name)
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
      if (dirent.isDirectory()) {
        await walk(abs, relative)
      } else if (dirent.isFile()) {
        lines.push(`${relative}\0${(await stat(abs)).size}`)
      }
    }
  }
  await walk(root, '')
  lines.sort()
  return sha256(lines.join('\n'))
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
  const bytes = Buffer.from(await response.arrayBuffer())
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

/** Identity of an analysis: same commit, same subpath, same engine, same run. */
export function deriveRunId(input: {
  sha: string
  ref: string
  subpath: string
  engineVersion: string
}): string {
  return sha256(stableJson(input)).slice(0, 12)
}

// --- safe extraction ------------------------------------------------------

const BLOCK = 512
/** ustar stores paths over 100 bytes as `prefix` + '/' + `name`. */
const MAGIC_START = 257
const PREFIX_START = 345
const PREFIX_LENGTH = 155

type PlannedEntry =
  | { kind: 'file'; name: string; target: string; data: Buffer }
  | { kind: 'dir'; name: string; target: string }

const unsafe = (name: string, reason: string): Error =>
  new Error(`anatomy: unsafe entry: ${name} (${reason})`)

/**
 * Extracts `archivePath` (gzip or plain tar) into `destDir`, refusing the whole
 * archive if any entry could write outside it.
 *
 * The archive is parsed and validated into a plan before the first write, so a
 * rejection leaves `destDir` empty even when the offending entry comes last.
 */
export async function extractTarSafe(
  archivePath: string,
  destDir: string,
): Promise<{ entries: number; bytes: number }> {
  const raw = await readFile(archivePath)
  const bytes = isGzip(raw) ? gunzipSync(raw) : raw
  const root = path.resolve(destDir)
  await mkdir(root, { recursive: true })

  const plan = planEntries(bytes, root)
  let written = 0
  for (const entry of plan) {
    if (entry.kind === 'dir') {
      await mkdir(entry.target, { recursive: true })
      continue
    }
    await mkdir(path.dirname(entry.target), { recursive: true })
    await writeFile(entry.target, entry.data)
    written += entry.data.length
  }
  return { entries: plan.length, bytes: written }
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

/** pax record payload -> `path` value, if the extended header carries one. */
function paxPath(body: Buffer): string | null {
  const text = body.toString('utf8')
  let rest = text
  while (rest.length > 0) {
    const space = rest.indexOf(' ')
    if (space === -1) break
    const length = Number.parseInt(rest.slice(0, space), 10)
    if (!Number.isFinite(length) || length <= 0 || length > rest.length) break
    const record = rest.slice(space + 1, length - 1) // drop the trailing \n
    const equals = record.indexOf('=')
    if (equals !== -1 && record.slice(0, equals) === 'path') return record.slice(equals + 1)
    rest = rest.slice(length)
  }
  return null
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
  let offset = 0

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break

    const size = readSize(header)
    const bodyStart = offset + BLOCK
    const bodyEnd = bodyStart + size
    if (bodyEnd > bytes.length) throw new Error('anatomy: truncated tar archive')
    const body = bytes.subarray(bodyStart, bodyEnd)
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK
    const typeflag = String.fromCharCode(header[156] ?? 0)

    // Metadata entries describe the next real entry; they are never extracted.
    if (typeflag === 'L') {
      overrideName = field(body)
      continue
    }
    if (typeflag === 'K') continue // long link name: the link itself is refused below
    if (typeflag === 'x' || typeflag === 'g') {
      const paxName = typeflag === 'x' ? paxPath(body) : null
      if (paxName !== null) overrideName = paxName
      continue
    }

    const headerName = overrideName ?? entryName(header)
    overrideName = null
    const name = headerName.startsWith('./') ? headerName.slice(2) : headerName
    const target = safeTarget(name, root)

    if (typeflag === '5') {
      plan.push({ kind: 'dir', name, target })
      continue
    }
    if (typeflag === '\0' || typeflag === '0' || typeflag === '7') {
      plan.push({ kind: 'file', name, target, data: Buffer.from(body) })
      continue
    }
    const reason =
      typeflag === '1'
        ? 'hard link'
        : typeflag === '2'
          ? 'symbolic link'
          : typeflag === '3' || typeflag === '4'
            ? 'device node'
            : typeflag === '6'
              ? 'fifo'
              : `unsupported typeflag "${typeflag}"`
    throw unsafe(name, reason)
  }

  return plan
}
