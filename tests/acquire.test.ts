import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  deriveRunId,
  downloadArchive,
  extractTarSafe,
  resolveSource,
  type AcquireDeps,
} from '../src/kernel/acquire.js'
import {
  device,
  dirEntry,
  fifo,
  file,
  gzip,
  hardlink,
  longName,
  pax,
  symlink,
  tar,
  type EntrySpec,
} from './helpers/tar.js'

// --- helpers --------------------------------------------------------------

const EVIL_DIR = fileURLToPath(new URL('./fixtures/evil/', import.meta.url))

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'anatomy-acquire-'))
  created.push(dir)
  return dir
}

const created: string[] = []

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Writes `entries` as a plain (uncompressed) tar into a temp path. */
async function archiveOf(entries: EntrySpec[], gzipped = false): Promise<string> {
  const dir = await tempDir()
  const archive = path.join(dir, gzipped ? 'archive.tar.gz' : 'archive.tar')
  const bytes = tar(entries)
  await writeFile(archive, gzipped ? gzip(bytes) : bytes)
  return archive
}

type FetchCall = { url: string; init?: RequestInit }

/** A `fetch` stand-in that records calls and answers with a canned response. */
function fakeFetch(respond: (url: string) => Response | Promise<Response>): {
  impl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return respond(url)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const october12 = () => new Date('2026-11-12T03:04:05.000Z')
const deps = (fetchImpl: typeof fetch): AcquireDeps => ({ fetchImpl, now: october12 })

// --- resolveSource --------------------------------------------------------

describe('resolveSource on GitHub references', () => {
  it('turns the latest release tag into a codeload tarball URL', async () => {
    const { impl, calls } = fakeFetch(() => json({ tag_name: 'v1.2.3' }))
    const source = await resolveSource('https://github.com/acme/widget', {}, deps(impl))

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/acme/widget/releases/latest',
    ])
    expect(source).toStrictEqual({
      kind: 'archive',
      url: 'https://codeload.github.com/acme/widget/tar.gz/v1.2.3',
      ref: 'v1.2.3',
      sha: '',
      subpath: '',
    })
  })

  it('prefers the tarball URL the release API hands back', async () => {
    const tarball = 'https://api.github.com/repos/acme/widget/tarball/v2.0.0'
    const { impl } = fakeFetch(() => json({ tag_name: 'v2.0.0', tarball_url: tarball }))
    const source = await resolveSource('https://github.com/acme/widget', {}, deps(impl))
    expect(source.url).toBe(tarball)
    expect(source.ref).toBe('v2.0.0')
  })

  it('reads /tree/<ref>/<path> as the ref and the subpath, without asking the API', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error('resolveSource must not call the network for an explicit ref')
    })
    const source = await resolveSource(
      'https://github.com/acme/widget/tree/v9/packages/core',
      {},
      deps(impl),
    )
    expect(calls).toEqual([])
    expect(source.ref).toBe('v9')
    expect(source.subpath).toBe('packages/core')
    expect(source.url).toBe('https://codeload.github.com/acme/widget/tar.gz/v9')
  })

  it('treats /tree/<ref> with no path as the whole repository', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error('resolveSource must not call the network for an explicit ref')
    })
    const noPath = await resolveSource('https://github.com/acme/widget/tree/main', {}, deps(impl))
    expect(noPath.ref).toBe('main')
    expect(noPath.subpath).toBe('')

    const trailing = await resolveSource('https://github.com/acme/widget/tree/dev/src/lib/', {}, deps(impl))
    expect(trailing.ref).toBe('dev')
    expect(trailing.subpath).toBe('src/lib')
    expect(calls).toEqual([])
  })

  it('strips a .git suffix and ignores a trailing slash', async () => {
    const { impl } = fakeFetch(() => json({ tag_name: 'v3' }))
    const source = await resolveSource('https://github.com/acme/widget.git/', {}, deps(impl))
    expect(source.url).toBe('https://codeload.github.com/acme/widget/tar.gz/v3')
  })

  it('lets an explicit ref win over the release lookup', async () => {
    const { impl, calls } = fakeFetch(() => json({ tag_name: 'v1.0.0' }))
    const source = await resolveSource('https://github.com/acme/widget', { ref: 'dev' }, deps(impl))
    expect(calls).toEqual([])
    expect(source.ref).toBe('dev')
    expect(source.url).toBe('https://codeload.github.com/acme/widget/tar.gz/dev')
  })

  it('falls back to the default branch, stamped with the fetch date, when the API fails', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('offline')
    })
    const source = await resolveSource('https://github.com/acme/widget', {}, deps(impl))
    expect(source).toStrictEqual({
      kind: 'archive',
      url: 'https://codeload.github.com/acme/widget/tar.gz/HEAD',
      ref: 'HEAD@2026-11-12',
      sha: '',
      subpath: '',
    })
  })

  it('falls back on a 404 and on a release payload with no tag', async () => {
    const notFound = fakeFetch(() => json({ message: 'Not Found' }, 404))
    expect((await resolveSource('https://github.com/a/b', {}, deps(notFound.impl))).ref).toBe(
      'HEAD@2026-11-12',
    )

    const noTag = fakeFetch(() => json({ name: 'no releases here' }))
    expect((await resolveSource('https://github.com/a/b', {}, deps(noTag.impl))).ref).toBe(
      'HEAD@2026-11-12',
    )
  })
})

describe('resolveSource on other inputs', () => {
  it('accepts a non-GitHub tarball URL as-is, without fetching it', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error('resolveSource must not download the archive')
    })
    const source = await resolveSource('https://example.com/drops/widget-1.0.tar.gz', {}, deps(impl))
    expect(calls).toEqual([])
    expect(source).toStrictEqual({
      kind: 'archive',
      url: 'https://example.com/drops/widget-1.0.tar.gz',
      ref: 'HEAD@2026-11-12',
      sha: '',
      subpath: '',
    })
  })

  it('hashes a local directory tree into a deterministic sha', async () => {
    const repo = await tempDir()
    await mkdir(path.join(repo, 'src'), { recursive: true })
    await writeFile(path.join(repo, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(path.join(repo, 'README.md'), '# widget\n')

    const { impl, calls } = fakeFetch(() => {
      throw new Error('a local directory needs no network')
    })
    const source = await resolveSource(repo, {}, deps(impl))

    expect(calls).toEqual([])
    expect(source.kind).toBe('local')
    expect(source.path).toBe(path.resolve(repo))
    expect(source.subpath).toBe('')
    expect(source.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(source.sha).toBe((await resolveSource(repo, {}, deps(impl))).sha)

    // Renaming a file changes the digest: paths are part of the hash.
    await writeFile(path.join(repo, 'README.md'), '# widget, edited\n')
    const renamed = await resolveSource(repo, {}, deps(impl))
    expect(renamed.sha).not.toBe(source.sha)
  })

  it('rejects input that is neither a URL nor a directory', async () => {
    const { impl } = fakeFetch(() => json({ tag_name: 'v1' }))
    await expect(resolveSource('', {}, deps(impl))).rejects.toThrow(/anatomy: /)
    await expect(resolveSource('not-a-source', {}, deps(impl))).rejects.toThrow(/anatomy: /)
    // Anatomy never runs `git`, so an scp-style remote is not a supported input.
    await expect(resolveSource('git@github.com:acme/widget.git', {}, deps(impl))).rejects.toThrow(
      /cannot resolve source/,
    )
  })
})

describe('downloadArchive', () => {
  it('writes the bytes and reports their sha256', async () => {
    const bytes = Buffer.from('pretend this is a tarball')
    const { impl, calls } = fakeFetch(() => new Response(bytes))
    const dir = await tempDir()
    const dest = path.join(dir, 'nested', 'widget.tar.gz')

    const result = await downloadArchive(
      { kind: 'archive', url: 'https://example.com/w.tar.gz', ref: 'v1', sha: '', subpath: '' },
      dest,
      deps(impl),
    )

    expect(calls.map((call) => call.url)).toEqual(['https://example.com/w.tar.gz'])
    expect(await readFile(dest)).toStrictEqual(bytes)
    expect(result.bytes).toBe(bytes.length)
    // sha256('pretend this is a tarball')
    expect(result.sha).toBe(
      '349438e5faf763e8875b43de4d7101540ef4d865190336c2cc549a11f33f8d7c',
    )
  })

  it('fails loudly on a non-OK response', async () => {
    const { impl } = fakeFetch(() => new Response('nope', { status: 503 }))
    await expect(
      downloadArchive(
        { kind: 'archive', url: 'https://example.com/w.tar.gz', ref: 'v1', sha: '', subpath: '' },
        path.join(await tempDir(), 'w.tar.gz'),
        deps(impl),
      ),
    ).rejects.toThrow(/download failed/)
  })
})

// --- deriveRunId ----------------------------------------------------------

describe('deriveRunId', () => {
  const input = { sha: 'a'.repeat(64), ref: 'v1.2.3', subpath: 'src', engineVersion: '0.0.1' }

  it('is a stable 12 hex character digest', () => {
    expect(deriveRunId(input)).toMatch(/^[0-9a-f]{12}$/)
    expect(deriveRunId(input)).toBe(deriveRunId({ ...input }))
    // Key order in the caller's object must not matter.
    expect(
      deriveRunId({
        engineVersion: input.engineVersion,
        subpath: input.subpath,
        ref: input.ref,
        sha: input.sha,
      }),
    ).toBe(deriveRunId(input))
  })

  it('changes when any field changes', () => {
    for (const change of [
      { sha: 'b'.repeat(64) },
      { ref: 'v2' },
      { subpath: '' },
      { engineVersion: '0.0.2' },
    ]) {
      expect(deriveRunId({ ...input, ...change })).not.toBe(deriveRunId(input))
    }
  })
})

// --- extractTarSafe: the malicious archives -------------------------------

const EVIL: Array<{ name: string; reason: RegExp; entries: EntrySpec[] }> = [
  {
    name: 'abs.tar',
    reason: /unsafe entry: \/tmp\/anatomy-abs-escape\.txt \(absolute path\)/,
    entries: [file('safe/ok.txt', 'ok\n'), file('/tmp/anatomy-abs-escape.txt', 'pwned\n')],
  },
  {
    name: 'dotdot.tar',
    reason: /unsafe entry: \.\.\/\.\.\/anatomy-dotdot-escape\.txt \(path traversal\)/,
    entries: [file('safe/ok.txt', 'ok\n'), file('../../anatomy-dotdot-escape.txt', 'pwned\n')],
  },
  {
    name: 'symlink.tar',
    reason: /unsafe entry: safe\/link \(symbolic link\)/,
    entries: [file('safe/ok.txt', 'ok\n'), symlink('safe/link', '/etc/passwd')],
  },
]

beforeAll(async () => {
  await mkdir(EVIL_DIR, { recursive: true })
  for (const evil of EVIL) {
    await writeFile(path.join(EVIL_DIR, evil.name), tar(evil.entries))
  }
})

describe('extractTarSafe rejects archives that escape the destination', () => {
  for (const evil of EVIL) {
    it(`rejects fixtures/evil/${evil.name} and leaves nothing behind`, async () => {
      const dest = await tempDir()
      const attempt = extractTarSafe(path.join(EVIL_DIR, evil.name), dest)

      await expect(attempt).rejects.toThrow(/unsafe entry/)
      await expect(attempt).rejects.toThrow(evil.reason)

      // A benign entry (`safe/ok.txt`) comes first in every fixture, so an
      // implementation that writes as it parses would leave it here.
      expect(await readdir(dest)).toEqual([])
      expect(await exists('/tmp/anatomy-abs-escape.txt')).toBe(false)
      expect(await exists(path.resolve(dest, '../../anatomy-dotdot-escape.txt'))).toBe(false)
    })
  }

  it('names the offending entry and why it was refused', async () => {
    for (const evil of EVIL) {
      await expect(extractTarSafe(path.join(EVIL_DIR, evil.name), await tempDir())).rejects.toThrow(
        evil.reason,
      )
    }
  })

  for (const [label, entry, reason] of [
    ['hard links', hardlink('hard', '/etc/passwd'), /hard link/],
    ['character devices', device('tty'), /device node/],
    ['fifos', fifo('pipe'), /fifo/],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const dest = await tempDir()
      const archive = await archiveOf([file('safe/ok.txt', 'ok\n'), entry])
      await expect(extractTarSafe(archive, dest)).rejects.toThrow(reason)
      expect(await readdir(dest)).toEqual([])
    })
  }

  it('rejects a name that only escapes once resolved', async () => {
    const dest = await tempDir()
    const archive = await archiveOf([file('a/b/../../../escape.txt', 'pwned\n')])
    await expect(extractTarSafe(archive, dest)).rejects.toThrow(/unsafe entry/)
    expect(await readdir(dest)).toEqual([])
  })
})

// --- extractTarSafe: the happy paths --------------------------------------

describe('extractTarSafe on well-formed archives', () => {
  it('extracts a gzipped archive and reports what it wrote', async () => {
    const dest = await tempDir()
    const archive = await archiveOf(
      [
        dirEntry('pkg'),
        file('pkg/readme.md', '# widget\n'),
        file('pkg/src/main.ts', 'export const x = 1\n'),
        file('pkg/empty.txt', ''),
      ],
      true,
    )

    const result = await extractTarSafe(archive, dest)

    expect(result).toStrictEqual({
      entries: 4,
      bytes: Buffer.byteLength('# widget\n') + Buffer.byteLength('export const x = 1\n'),
    })
    expect(await readFile(path.join(dest, 'pkg/readme.md'), 'utf8')).toBe('# widget\n')
    expect(await readFile(path.join(dest, 'pkg/src/main.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(await readFile(path.join(dest, 'pkg/empty.txt'), 'utf8')).toBe('')
    expect((await stat(path.join(dest, 'pkg'))).isDirectory()).toBe(true)
  })

  it('extracts an uncompressed archive and preserves binary bytes', async () => {
    const dest = await tempDir()
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x0d, 0x80])
    const archive = await archiveOf([file('assets/logo.bin', bytes)])

    await extractTarSafe(archive, dest)

    expect(await readFile(path.join(dest, 'assets/logo.bin'))).toStrictEqual(bytes)
  })

  it('joins the ustar prefix field with the name field', async () => {
    const dest = await tempDir()
    const archive = await archiveOf([
      file('core.ts', 'export const core = true\n', { prefix: 'deep/nested/dir' }),
    ])

    const result = await extractTarSafe(archive, dest)

    expect(result.entries).toBe(1)
    expect(await readFile(path.join(dest, 'deep/nested/dir/core.ts'), 'utf8')).toBe(
      'export const core = true\n',
    )
  })

  it('strips one leading ./ from entry names', async () => {
    const dest = await tempDir()
    const archive = await archiveOf([
      file('./pkg/a.txt', 'a\n'),
      file('./pkg/nested/b.txt', 'b\n'),
    ])

    await extractTarSafe(archive, dest)

    expect(await readFile(path.join(dest, 'pkg/a.txt'), 'utf8')).toBe('a\n')
    expect(await readFile(path.join(dest, 'pkg/nested/b.txt'), 'utf8')).toBe('b\n')
    // `./pkg` is stripped, not materialised as a literal `./` path segment.
    expect((await readdir(dest)).sort()).toStrictEqual(['pkg'])
  })

  it('follows a GNU long-name entry for the path that does not fit the header', async () => {
    const dest = await tempDir()
    const long = `pkg/${'d'.repeat(60)}/${'f'.repeat(40)}.txt`
    expect(long.length).toBeGreaterThan(100)
    const archive = await archiveOf([longName(long), file('widget.txt', 'long\n')])

    await extractTarSafe(archive, dest)

    expect(await readFile(path.join(dest, long), 'utf8')).toBe('long\n')
  })

  it('consumes pax extended headers and honours their path record', async () => {
    const dest = await tempDir()
    const long = `pax/${'e'.repeat(60)}/${'g'.repeat(40)}.txt`
    expect(long.length).toBeGreaterThan(100)
    const archive = await archiveOf([
      pax({ path: long, mtime: '1700000000.000000000' }),
      file('placeholder.txt', 'pax\n'),
    ])

    await extractTarSafe(archive, dest)

    expect(await readFile(path.join(dest, long), 'utf8')).toBe('pax\n')
    expect(await exists(path.join(dest, 'placeholder.txt'))).toBe(false)
  })

  it('creates the destination when it does not exist yet', async () => {
    const parent = await tempDir()
    const dest = path.join(parent, 'fresh')
    const archive = await archiveOf([file('a.txt', 'a\n')])

    await extractTarSafe(archive, dest)

    expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('a\n')
  })
})
