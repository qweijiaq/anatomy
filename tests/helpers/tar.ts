/**
 * Builds tar archives byte by byte.
 *
 * Two reasons this exists instead of shelling out to `tar`:
 *
 * 1. The safety tests need entries no sane archiver will produce on request
 *    (absolute names, `..` segments, symlinks, device nodes). A generator that
 *    writes the 512-byte header itself can express those precisely.
 * 2. Bytes are deterministic (mtime 0, uid/gid 0, fixed ustar magic), so the
 *    committed fixtures under `tests/fixtures/evil/` are reproducible from this
 *    file and a mismatch shows up as a diff instead of silent drift.
 */

import { gzipSync } from 'node:zlib'

const BLOCK = 512

export type EntrySpec = {
  /** Value of the 100-byte `name` field, verbatim (no normalization). */
  name: string
  body?: string | Buffer
  typeflag?: string
  /** 100-byte `linkname` field. */
  linkname?: string
  /** ustar `prefix` field: the real path is `prefix + '/' + name`. */
  prefix?: string
  mode?: number
}

/** Octal field, zero padded to `width` with the trailing NUL the format requires. */
function octalField(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function headerFor(spec: EntrySpec, size: number): Buffer {
  const header = Buffer.alloc(BLOCK)
  const nameBytes = Buffer.from(spec.name, 'utf8')
  if (nameBytes.length > 100) {
    throw new Error(`tar helper: name does not fit the 100-byte field: ${spec.name}`)
  }
  nameBytes.copy(header, 0)
  header.write(octalField(spec.mode ?? (spec.typeflag === '5' ? 0o755 : 0o644), 8), 100, 'latin1')
  header.write(octalField(0, 8), 108, 'latin1') // uid
  header.write(octalField(0, 8), 116, 'latin1') // gid
  header.write(octalField(size, 12), 124, 'latin1')
  header.write(octalField(0, 12), 136, 'latin1') // mtime: 0 keeps the bytes stable
  header.write('        ', 148, 'latin1') // checksum placeholder
  header.write(spec.typeflag ?? '0', 156, 'latin1')
  if (spec.linkname !== undefined) Buffer.from(spec.linkname, 'utf8').copy(header, 157)
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  header.write('root', 265, 'latin1')
  header.write('root', 297, 'latin1')
  if (spec.prefix !== undefined) Buffer.from(spec.prefix, 'utf8').copy(header, 345)

  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return header
}

function padToBlock(body: Buffer): Buffer {
  const remainder = body.length % BLOCK
  return remainder === 0 ? body : Buffer.concat([body, Buffer.alloc(BLOCK - remainder)])
}

function buildEntry(spec: EntrySpec): Buffer {
  const body = spec.body === undefined ? Buffer.alloc(0) : Buffer.from(spec.body)
  return Buffer.concat([headerFor(spec, body.length), padToBlock(body)])
}

/** Full archive: entries in order, then the required two zero blocks. */
export function tar(entries: EntrySpec[]): Buffer {
  return Buffer.concat([...entries.map(buildEntry), Buffer.alloc(BLOCK * 2)])
}

export const gzip = (archive: Buffer): Buffer => gzipSync(archive)

export const file = (name: string, body: string | Buffer, extra: Partial<EntrySpec> = {}): EntrySpec => ({
  name,
  body,
  ...extra,
})

export const dirEntry = (name: string, extra: Partial<EntrySpec> = {}): EntrySpec => ({
  name: name.endsWith('/') ? name : `${name}/`,
  typeflag: '5',
  ...extra,
})

export const symlink = (name: string, target: string): EntrySpec => ({
  name,
  typeflag: '2',
  linkname: target,
})

export const hardlink = (name: string, target: string): EntrySpec => ({
  name,
  typeflag: '1',
  linkname: target,
})

export const device = (name: string): EntrySpec => ({ name, typeflag: '3' })

export const fifo = (name: string): EntrySpec => ({ name, typeflag: '6' })

/** GNU long-name entry (typeflag `L`): the next entry's name is this body. */
export const longName = (name: string): EntrySpec => ({
  name: '././@LongLink',
  typeflag: 'L',
  body: `${name}\0`,
})

/**
 * pax extended header (typeflag `x`). Records are `"<length> <key>=<value>\n"`
 * where `<length>` counts the whole record, including its own digits.
 */
export function pax(records: Record<string, string>): EntrySpec {
  const encoded = Object.entries(records)
    .map(([key, value]) => {
      const tail = ` ${key}=${value}\n`
      let length = Buffer.byteLength(tail) + 1
      while (Buffer.byteLength(`${length}${tail}`) !== length) {
        length = Buffer.byteLength(`${length}${tail}`)
      }
      return `${length}${tail}`
    })
    .join('')
  return { name: 'pax_global_header', typeflag: 'x', body: encoded }
}
