/**
 * What a channel or member can do, judged by its name.
 *
 * This is a heuristic and it is labelled as one wherever it is shown. It exists
 * because a flat list of ten channels is not a finding: `app:info` and
 * `analysis:run` are both "one channel" and they are not the same thing to expose
 * to a renderer. Grouping them is the difference between a catalogue and a reading.
 *
 * The vocabulary is deliberately small and matched on *tokens* — split at `:`,
 * `.`, `_`, `-` and case boundaries — because substring matching is how `ring`
 * once fired on `asString`. Nothing here inspects whether a handler validates its
 * sender or what it does with its arguments; REA does not report that, and a name
 * cannot carry it.
 */

export type SurfaceGroup = 'privileged' | 'write' | 'read' | 'event' | 'other'

/**
 * Names that suggest the channel reaches past the app's own data: the filesystem,
 * a process, a system dialog, the network, or a whole analysis run.
 *
 * Checked first, because `dialog:pickFolder` contains no read/write verb at all and
 * `analysis:run` would otherwise fall through to "other".
 */
const PRIVILEGED = new Set([
  'pick',
  'dialog',
  'open',
  'dialogfolder',
  'exec',
  'spawn',
  'shell',
  'fs',
  'file',
  'files',
  'dir',
  'folder',
  'path',
  'download',
  'upload',
  'install',
  'uninstall',
  'eval',
  'run',
  'execute',
  'launch',
  'kill',
  'restart',
  'fetch',
  'http',
  'request',
  'net',
  'network',
  'process',
  'binary',
  'native',
  'credential',
  'secret',
  'token',
  'password',
  'key',
])

const WRITE = new Set([
  'save',
  'set',
  'write',
  'update',
  'put',
  'post',
  'create',
  'add',
  'insert',
  'delete',
  'remove',
  'clear',
  'reset',
  'patch',
  'apply',
  'commit',
  'send',
  'push',
  'emit',
  'upload',
])

const READ = new Set([
  'read',
  'list',
  'get',
  'info',
  'status',
  'load',
  'fetch',
  'query',
  'search',
  'find',
  'exists',
  'count',
  'version',
  'describe',
  'inspect',
  'check',
  'has',
])

const EVENT = new Set([
  'on',
  'progress',
  'event',
  'events',
  'change',
  'changed',
  'update',
  'updated',
  'subscribe',
  'watch',
  'stream',
  'notify',
  'notification',
])

/** `models:list` → `['models', 'list']`; `pickFolder` → `['pick', 'folder']`. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase())
}

/**
 * The group a name belongs to.
 *
 * Precedence is fixed so a name lands in one place: privileged beats write beats
 * read beats event. An `on` prefix is checked before everything, because
 * `analysis:progress` is a listener and saying so is more useful than filing it
 * under the verb it happens to contain.
 */
export function classifyName(name: string): SurfaceGroup {
  const tokens = nameTokens(name)
  if (tokens.length === 0) return 'other'
  if (tokens.some((token) => PRIVILEGED.has(token))) return 'privileged'
  if (tokens.some((token) => WRITE.has(token))) return 'write'
  if (tokens.some((token) => READ.has(token))) return 'read'
  if (tokens.some((token) => EVENT.has(token))) return 'event'
  return 'other'
}

export type GroupedNames = Record<SurfaceGroup, string[]>

/** Group in the order a reader should read them: worst first. */
const ORDER: readonly SurfaceGroup[] = ['privileged', 'write', 'read', 'event', 'other']

export function groupNames(names: readonly string[]): GroupedNames {
  const grouped: GroupedNames = { privileged: [], write: [], read: [], event: [], other: [] }
  for (const name of names) grouped[classifyName(name)].push(name)
  for (const key of ORDER) grouped[key].sort((a, b) => a.localeCompare(b))
  return grouped
}
