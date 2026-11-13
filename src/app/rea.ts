/**
 * REA, as a source of facts about an application that has no readable source.
 *
 * anatomy needs source: it indexes modules, reads functions and quotes lines. An
 * Electron app that ships as a minified bundle or an ASAR has none of that, and
 * that is exactly the case [REA](https://github.com/morluto/rea) covers — it
 * reconstructs modules, IPC channels, contextBridge surfaces and storage relations
 * from shipped artifacts, with an evidence id on every claim.
 *
 * The two systems agree on the part that matters: neither will state a fact it
 * cannot point at. So REA is wired in as a *source* of candidates, not a second
 * opinion — its `limitations` land in the same「没看的部分」that anatomy's own
 * gaps do.
 *
 * ## The one hard constraint
 *
 * A single analysis of a 2.4 MB bundle produced **144 MB of JSON**, of which
 * 141.8 MB was `normalized_result.semantic_graph`. Loading that into the main
 * process to read a handful of counters would be absurd, and loading it into a
 * renderer would be worse. So:
 *
 * - the full evidence file is written to disk and never read back whole;
 * - the counters come from `inspect-analysis-view`, which projects one view and
 *   is cheap regardless of how large the fact store behind it is;
 * - the module graph is read from the file directly only under a size cap, and
 *   omitted (with a stated reason) above it.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { groupNames, type GroupedNames } from './classify.js'

const run = promisify(execFile)

/**
 * Above this, the graph is left in the evidence file.
 *
 * The graph is 1.9 MB against 144 MB of semantic store, so most files pass. The cap
 * exists because the cap is what keeps "parse it" from becoming the default and
 * the memory profile a function of the target's size rather than of ours.
 */
const MAX_PARSE_BYTES = 24 * 1024 * 1024

/** Ceiling for the evidence document itself. One measured run produced 144 MB. */
const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024

/** REA only ships as an ESM script; it needs a Node the package's engines field allows. */
const MIN_NODE = { major: 22, minor: 23 } as const

export type ReaLocation = { entry: string; node: string }

/** What the Electron layer of an application looks like, in REA's own counters. */
export type AppSurface = {
  browserWindows: number
  preloadEntrypoints: number
  contextBridgeApis: number
  exposedApiMembers: number
  ipcOperations: number
  ipcLiteralChannels: number
  ipcMainHandlers: number
  rendererTransmissions: number
  rendererListeners: number
  /** Registered transmissions REA could not pair with a handler. */
  ambiguousTransmissions: number
  senderValidationObservations: number
  nativeAddonBindings: number
  protocolRegistrations: number
  /** `partial` when REA could not read every artifact it found. */
  semantics: string
}

/**
 * One node of REA's graph, with the names it carries.
 *
 * `identity.key` is a location (`main:ana:49:0-49:59`) and is useless as a label;
 * the name a reader wants is in `observations[].label` — `models:list` for a
 * channel, `ana` for a bridge. A bridge also carries `properties.members`, which is
 * the list of `settings.read` / `report.list` paths it exposes. Both were being
 * dropped, which left the view saying "10 operations" instead of naming the ten.
 */
export type AppModule = {
  id: string
  kind: string
  label: string
  artifact: string
  /** Every `observations[].label` on this node, deduplicated. */
  labels: string[]
  /** For a `context-bridge-api`: the member paths it exposes. */
  members: string[]
  /** For an `ipc-channel`: `invoke` / `send` / `on`, when REA recorded one. */
  operation: string
}

export type AppRelation = { from: string; to: string; relation: string }

/** One survey of one application: everything a reader can be shown, and nothing else. */
export type AppSurvey = {
  evidenceId: string
  confidence: string
  authority: string
  /** The directory that was analysed. */
  target: string
  /** REA's own name for it, taken from the artifact. */
  name: string
  format: string
  digest: string
  surface: AppSurface
  statistics: {
    relevantFiles: number
    parsedJavaScriptFiles: number
    visitedAstNodes: number
    findings: number
    textBytesRead: number
    parseFailures: number
  }
  /** REA's statements about what it could not see. Reader-facing by design. */
  limitations: string[]
  modules: AppModule[]
  relations: AppRelation[]
  /**
   * Channels and exposed members grouped by what their names suggest they do.
   *
   * A flat list of ten channels is a catalogue; `privileged` is the reading. Kept
   * in the survey rather than derived in the view so the CLI prints the same
   * grouping the window shows.
   */
  groups: { channels: GroupedNames; members: GroupedNames }
  /**
   * Every channel with whether REA found a receiver for it.
   *
   * Derived from the graph, not from the summary count: a `handles` edge pointing
   * at an `ipc-channel` is a receiver, and its absence is the thing worth naming —
   * "9 unpaired" is a number, the nine names are the finding.
   */
  pairs: Array<{ name: string; operation: string; handled: boolean }>
  /** Why the graph is missing, when it is. Empty when it is present. */
  graphOmitted: string
  /** True when the first pass hit REA's worker heap and a narrower pass was run. */
  retried: boolean
  /** What the retry did, in the reader's words. Empty when no retry happened. */
  retryNote: string
  /** Where the untouched evidence file lives, for anyone who wants the fact store. */
  evidenceFile: string
  /** The rendered facts report beside it. */
  reportPath: string
}

/**
 * Does this limitation say the analyser ran out of memory?
 *
 * REA reports it two ways — `exhausted its 1024 MiB V8 old-space heap` per file,
 * and `(max_heap_mb)` inside the resource-constraint text — and both mean the same
 * thing: the file was skipped, so every counter derived from it is a lower bound.
 * That is the condition worth retrying, and it is distinguishable from "this
 * directory has no Electron in it", which retrying would not fix.
 */
export function heapLimited(limitations: readonly string[]): boolean {
  return limitations.some((item) => /exhausted its [\d.]+ ?[GM]iB/i.test(item) || /max_heap_mb/i.test(item))
}

/**
 * The small files that carry an Electron surface, by name.
 *
 * A bundle that exhausts a 1 GiB heap is by definition not where the boundary is
 * declared — `preload` and the main entry are, and they are kilobytes. Matching on
 * the file name is crude, and it is what REA's own guidance says to do when a pass
 * is too large: name first-party main and preload files, analyse fewer sources.
 */
const SMALL_SOURCE = /^(?:preload|main|index|entry)\.(?:c|m)?js$/i
export const SMALL_SOURCE_MAX_BYTES = 2 * 1024 * 1024

export async function pickSmallSources(target: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relative, depth + 1)
        continue
      }
      if (!entry.isFile() || !SMALL_SOURCE.test(entry.name)) continue
      try {
        const info = await stat(absolute)
        if (info.size <= SMALL_SOURCE_MAX_BYTES) found.push(relative)
      } catch {
        // A file that vanished mid-walk is not a candidate.
      }
    }
  }
  await walk(path.resolve(target), '', 0)
  return found.sort()
}

/** Raised when REA is not installed, or is installed for a Node that cannot run it. */
export class ReaUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReaUnavailableError'
  }
}

function nodeVersionOk(node: string): Promise<boolean> {
  return run(node, ['-e', 'process.stdout.write(process.versions.node)'], { timeout: 10_000 })
    .then(({ stdout }) => {
      const [major = 0, minor = 0] = stdout.trim().split('.').map(Number)
      return (
        (major === MIN_NODE.major && minor >= MIN_NODE.minor) ||
        (major === 24 && minor >= 22) ||
        major >= 26
      )
    })
    .catch(() => false)
}

/** Every place an `npx rea-agents` install can have left an entry script. */
async function npxCandidates(): Promise<string[]> {
  const found: string[] = []
  const roots = [
    path.join(homedir(), '.local', 'npm-cache-rea', '_npx'),
    path.join(homedir(), '.npm', '_npx'),
  ]
  for (const root of roots) {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = path.join(root, entry, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Find a REA that can actually run.
 *
 * Three sources, in order of how much the caller meant them: `ANA_REA` (an explicit
 * path, for a checkout or a non-npx install), `rea` on `PATH`, then whatever `npx`
 * left behind. The Node that will run it is the one that passes the engines check —
 * a REA found under an older Node is not a REA that works, and reporting that is
 * more useful than a parse error three steps later.
 */
export async function findRea(): Promise<ReaLocation> {
  const explicit = process.env['ANA_REA']
  const onPath = await run('which', ['rea'], { timeout: 5000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')

  const entries = [explicit, onPath, ...(await npxCandidates())].filter(
    (item): item is string => typeof item === 'string' && item !== '',
  )
  if (entries.length === 0) {
    throw new ReaUnavailableError(
      '没找到 rea。装一次就好：`npx rea-agents setup`，或者把 ANA_REA 指向它的 scripts/rea.mjs。',
    )
  }

  const nodes = [process.execPath, path.join(homedir(), '.local', 'node-v24.22.3-darwin-arm64', 'bin', 'node')]
  for (const node of nodes) {
    if (!existsSync(node)) continue
    if (!(await nodeVersionOk(node))) continue
    return { entry: entries[0] as string, node }
  }

  throw new ReaUnavailableError(
    '找到了 rea，但没有能跑它的 Node。它要求 ^22.23.4 || ^24.22.1 || >=26.12.1，' +
      '而当前 Node 是 ' +
      process.versions.node +
      '。装一个新的 Node 后把 ANA_REA_NODE 指过去。',
  )
}

/** Start REA once and keep the promise: locating it is not free and does not change. */
let cached: Promise<ReaLocation> | null = null
export function reaLocation(): Promise<ReaLocation> {
  cached ??= findRea()
  return cached
}

/**
 * Run REA and parse its one JSON document.
 *
 * `maxBuffer` is large because the document is: REA holds the whole analysis in
 * memory before printing it, so a bundle that produces 144 MB produces 144 MB of
 * stdout. Refusing it here would not save the memory — it would only move the
 * failure to a less informative place.
 */
/** One progress line as REA emits it on stderr. */
export type ReaProgress = {
  phase: string
  message: string
  /** `n/m` when REA is walking a list, otherwise null. */
  done: number | null
  total: number | null
}

/** A single line of REA's `{"rea_progress": …}` channel, or null for anything else. */
export function parseProgress(line: string): ReaProgress | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const progress = (parsed as { rea_progress?: unknown }).rea_progress
  if (typeof progress !== 'object' || progress === null) return null
  const record = progress as Record<string, unknown>
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  if (message === '') return null
  // `Parsing and projecting server/auth-store.js (1/73)` — the counts are in the
  // sentence, and they are the only reason a reader can tell 5% from 95%.
  const counts = /\((\d+)\/(\d+)\)\s*$/.exec(message)
  return {
    phase: typeof record['phase'] === 'string' ? record['phase'] : '',
    message,
    done: counts === null ? null : Number(counts[1]),
    total: counts === null ? null : Number(counts[2]),
  }
}

/**
 * Run REA and parse its one JSON document, reporting progress while it works.
 *
 * `execFile` was fine when this only had to produce a value: it buffers stderr and
 * hands back nothing until the process exits. But an application with a large
 * bundle takes two and a half minutes, and REA is emitting a progress line to
 * stderr the whole time — discarding them means the command looks hung. So this
 * spawns and reads stderr as it arrives.
 *
 * stdout is still accumulated whole, because the document is the document; the
 * difference is only that the silence is no longer total.
 */
async function reaJson(
  location: ReaLocation,
  args: string[],
  timeoutMs: number,
  maxBuffer = 8 * 1024 * 1024,
  onProgress?: (progress: ReaProgress) => void,
): Promise<unknown> {
  if (onProgress === undefined) {
    const { stdout } = await run(location.node, [location.entry, ...args], {
      timeout: timeoutMs,
      maxBuffer,
    })
    return JSON.parse(stdout) as unknown
  }

  const { spawn } = await import('node:child_process')
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(location.node, [location.entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    let stderrTail = ''

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`REA 超时（${Math.round(timeoutMs / 60_000)} 分钟）`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBuffer) {
        child.kill('SIGTERM')
        reject(new Error(`REA 的输出超过 ${Math.round(maxBuffer / 1048576)} MB`))
        return
      }
      chunks.push(chunk)
    })

    // stderr is a line channel; a chunk boundary is not a line boundary, so the
    // tail of the last incomplete line is carried over.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString('utf8')
      let index = stderrTail.indexOf('\n')
      while (index !== -1) {
        const line = stderrTail.slice(0, index)
        stderrTail = stderrTail.slice(index + 1)
        const progress = parseProgress(line)
        if (progress !== null) onProgress(progress)
        index = stderrTail.indexOf('\n')
      }
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`REA 退出码 ${String(code)}`))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        reject(new Error('REA 的输出不是 JSON'))
      }
    })
  })
}

function numberAt(source: unknown, key: string): number {
  const value = (source as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function surfaceFrom(summary: Record<string, unknown>): AppSurface {
  const ipc = (summary['ipc'] ?? {}) as Record<string, unknown>
  return {
    browserWindows: numberAt(summary, 'browser_windows'),
    preloadEntrypoints: numberAt(summary, 'preload_entrypoints'),
    contextBridgeApis: numberAt(summary, 'context_bridge_apis'),
    exposedApiMembers: numberAt(summary, 'exposed_api_members'),
    ipcOperations: numberAt(ipc, 'operations'),
    ipcLiteralChannels: numberAt(ipc, 'literal_channels'),
    ipcMainHandlers: numberAt(ipc, 'main_handlers'),
    rendererTransmissions: numberAt(ipc, 'renderer_transmissions'),
    rendererListeners: numberAt(ipc, 'renderer_listeners'),
    ambiguousTransmissions: numberAt(ipc, 'ambiguous_renderer_transmissions'),
    senderValidationObservations: numberAt(summary, 'sender_validation_observations'),
    nativeAddonBindings: numberAt(summary, 'native_addon_bindings'),
    protocolRegistrations: numberAt(summary, 'protocol_registrations'),
    semantics: typeof summary['electron_semantics'] === 'string' ? summary['electron_semantics'] : 'unknown',
  }
}

/** String fields only: a node identity carries hashes and we do not want them in a label. */
function labelOf(node: Record<string, unknown>): string {
  const identity = (node['identity'] ?? {}) as Record<string, unknown>
  for (const key of ['key', 'original_source', 'module_path', 'logical_path', 'path', 'name']) {
    const value = identity[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const kind = typeof node['kind'] === 'string' ? node['kind'] : 'node'
  const id = typeof node['node_id'] === 'string' ? node['node_id'] : ''
  return `${kind}:${id.slice(-8)}`
}

function artifactOf(node: Record<string, unknown>): string {
  const identity = (node['identity'] ?? {}) as Record<string, unknown>
  const value = identity['artifact_sha256']
  return typeof value === 'string' ? value.slice(0, 12) : ''
}

/**
 * The graph, read straight out of the evidence file.
 *
 * A projection for it does not exist — `inspect-analysis-view` offers `summary` and
 * `javascript-facts` — so this is the one place the file is parsed. The size cap is
 * the reason that is acceptable.
 */
async function readGraph(evidencePath: string): Promise<
  { modules: AppModule[]; relations: AppRelation[] } | { omitted: string }
> {
  const info = await stat(evidencePath)
  if (info.size > MAX_PARSE_BYTES) {
    return {
      omitted: `证据文件 ${(info.size / 1048576).toFixed(0)} MB，超过 ${
        MAX_PARSE_BYTES / 1048576
      } MB 的解析上限，模块图没有载入。文件本身在磁盘上，可以用 inspect-analysis-view 分页查询。`,
    }
  }
  const parsed = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>
  const normalized = (parsed['normalized_result'] ?? {}) as Record<string, unknown>
  const graph = (normalized['graph'] ?? {}) as Record<string, unknown>
  const nodes = Array.isArray(graph['nodes']) ? (graph['nodes'] as Record<string, unknown>[]) : []
  const edges = Array.isArray(graph['edges']) ? (graph['edges'] as Record<string, unknown>[]) : []

  const modules: AppModule[] = nodes.map((node) => {
    const observations = Array.isArray(node['observations'])
      ? (node['observations'] as Record<string, unknown>[])
      : []
    const labels: string[] = []
    const members: string[] = []
    let operation = ''
    for (const observation of observations) {
      if (typeof observation['label'] === 'string' && observation['label'] !== '') {
        if (!labels.includes(observation['label'])) labels.push(observation['label'])
      }
      const properties = (observation['properties'] ?? {}) as Record<string, unknown>
      if (operation === '' && typeof properties['operation'] === 'string') {
        operation = properties['operation']
      }
      const observed = properties['members']
      if (Array.isArray(observed)) {
        for (const member of observed) {
          if (typeof member === 'string' && !members.includes(member)) members.push(member)
        }
      }
    }
    return {
      id: typeof node['node_id'] === 'string' ? node['node_id'] : '',
      kind: typeof node['kind'] === 'string' ? node['kind'] : 'unknown',
      label: labels[0] ?? labelOf(node),
      artifact: artifactOf(node),
      labels,
      members,
      operation,
    }
  })
  const relations: AppRelation[] = edges
    .map((edge) => ({
      from: typeof edge['source_node_id'] === 'string' ? edge['source_node_id'] : '',
      to: typeof edge['target_node_id'] === 'string' ? edge['target_node_id'] : '',
      relation: typeof edge['relation'] === 'string' ? edge['relation'] : 'related',
    }))
    .filter((edge) => edge.from !== '' && edge.to !== '')
  return { modules, relations }
}

export type SurveyOptions = {
  /** Where the untouched evidence file goes. */
  outputDir: string
  /**
   * Exact inventoried paths to analyse instead of everything.
   *
   * This is the difference between a usable command and an unusable one. On a
   * 9.7 MB bundled main process, analysing everything exhausts REA's 1 GiB worker
   * heap after two minutes and returns zero Electron facts; naming the 2 KB preload
   * returns all of them in 1.2 seconds. The default stays "everything" because that
   * is the honest default — but a caller who knows where the surface is should not
   * have to pay for the parts they do not need.
   */
  sourcePaths?: string[]
  /** REA analyses a large app for minutes; this is the ceiling before we give up. */
  timeoutMs?: number
  /** Called as REA reports progress. Never required: output is identical without it. */
  onProgress?: (progress: ReaProgress) => void
}

/**
 * Analyse one application directory with REA and reduce it to what a reader can use.
 *
 * The evidence file stays in `outputDir` untouched. Everything returned here is
 * derived from cheap projections, except the graph, which is bounded.
 */
export async function surveyApplication(
  target: string,
  options: SurveyOptions,
): Promise<AppSurvey> {
  const location = await reaLocation()
  await mkdir(options.outputDir, { recursive: true })
  const evidencePath = path.join(options.outputDir, 'rea-evidence.json')

  const timeout = options.timeoutMs ?? 15 * 60_000
  const analyze = async (sourcePaths: string[]): Promise<Record<string, unknown>> => {
    const selection = sourcePaths.flatMap((item) => ['--source-path', item])
    return (await reaJson(
      location,
      ['analyze-javascript-application', target, ...selection, '--json'],
      timeout,
      MAX_EVIDENCE_BYTES,
      options.onProgress,
    )) as Record<string, unknown>
  }

  /**
   * How much of the Electron boundary a document actually carries.
   *
   * The comparison has to be on facts, not on exit status: both passes "succeed".
   */
  const exposedSurface = (document: Record<string, unknown>): number => {
    const normalized = (document['normalized_result'] ?? {}) as Record<string, unknown>
    const surface = surfaceFrom((normalized['summary'] ?? {}) as Record<string, unknown>)
    return surface.contextBridgeApis * 100 + surface.exposedApiMembers + surface.ipcOperations
  }

  const limitationsOf = (document: Record<string, unknown>): string[] => {
    const normalized = (document['normalized_result'] ?? {}) as Record<string, unknown>
    const list = normalized['limitations']
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  }

  let evidence = await analyze(options.sourcePaths ?? [])
  let retried = false
  let retryNote = ''

  // One retry, and only for the one failure that a narrower pass can fix. A bundle
  // too large for a 1 GiB worker heap is not a failure of the application; it is a
  // failure of trying to read all of it at once. The surface lives in kilobytes.
  if ((options.sourcePaths ?? []).length === 0 && heapLimited(limitationsOf(evidence))) {
    const small = await pickSmallSources(target)
    if (small.length > 0) {
      const second = await analyze(small)
      // Only take the retry if it actually saw more. A narrower pass that also
      // failed would swap a complete inventory for a partial one for nothing.
      if (exposedSurface(second) > exposedSurface(evidence)) {
        evidence = second
        retried = true
        retryNote = `第一次全量分析把 REA 的 worker 堆撑爆了（1 GiB），自动缩小范围重跑：只分析 ${small.join('、')}。下面的数字是这一次的，没有被分析的其余文件写在第一条限制里。`
      }
    }
  }

  // Written before anything is read back: the file is the record, and a crash below
  // must not lose an analysis that took minutes.
  await writeFile(evidencePath, JSON.stringify(evidence))

  // Read the small parts out of the document we already hold. An earlier version
  // re-projected them through `inspect-analysis-view` to avoid touching the file,
  // but the projection reports zeros for the Electron counters — the evidence says
  // `context_bridge_apis: 1, exposed_api_members: 15` and the projection said 0/0 —
  // and the parse it was avoiding had already happened, because stdout is the
  // document. One source of truth beats two.
  const parent = (evidence['normalized_result'] ?? {}) as Record<string, unknown>
  const summary = (parent['summary'] ?? {}) as Record<string, unknown>
  const statistics = (parent['statistics'] ?? {}) as Record<string, unknown>

  const graph = await readGraph(evidencePath)
  const modules = 'omitted' in graph ? [] : graph.modules
  const relations = 'omitted' in graph ? [] : graph.relations
  const handled = new Set(
    relations.filter((edge) => edge.relation === 'handles').map((edge) => edge.to),
  )
  const pairs = modules
    .filter((module) => module.kind === 'ipc-channel')
    .map((module) => ({
      name: module.label,
      operation: module.operation,
      handled: handled.has(module.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const groups = {
    channels: groupNames(modules.filter((m) => m.kind === 'ipc-channel').map((m) => m.label)),
    members: groupNames([
      ...new Set(
        modules.filter((m) => m.kind === 'context-bridge-api').flatMap((m) => m.members),
      ),
    ]),
  }
  const subject = (evidence['subject'] ?? {}) as Record<string, unknown>
  const digest = (subject['digest'] ?? {}) as Record<string, unknown>

  return {
    evidenceId: typeof evidence['evidence_id'] === 'string' ? evidence['evidence_id'] : '',
    confidence: typeof evidence['confidence'] === 'string' ? evidence['confidence'] : 'unknown',
    authority: typeof evidence['authority'] === 'string' ? evidence['authority'] : 'unknown',
    target,
    name:
      typeof subject['name'] === 'string'
        ? subject['name']
        : path.basename(path.resolve(target)),
    format: typeof subject['format'] === 'string' ? subject['format'] : 'directory',
    digest: typeof digest['sha256'] === 'string' ? digest['sha256'].slice(0, 12) : '',
    surface: surfaceFrom(summary),
    statistics: {
      relevantFiles: numberAt(statistics, 'relevant_files'),
      parsedJavaScriptFiles: numberAt(statistics, 'parsed_javascript_files'),
      visitedAstNodes: numberAt(statistics, 'visited_ast_nodes'),
      findings: numberAt(statistics, 'findings'),
      textBytesRead: numberAt(statistics, 'text_bytes_read'),
      parseFailures: numberAt(statistics, 'parse_failures'),
    },
    // Not filtered or paraphrased. REA is explicit about what its numbers do *not*
    // prove, and that is the half of the report anatomy exists to keep honest.
    limitations: Array.isArray(parent['limitations'])
      ? (parent['limitations'] as unknown[]).filter((item): item is string => typeof item === 'string')
      : [],
    groups,
    pairs,
    modules,
    relations: 'omitted' in graph ? [] : graph.relations,
    graphOmitted: 'omitted' in graph ? graph.omitted : '',
    retried,
    retryNote,
    evidenceFile: evidencePath,
    // Filled in by the command, which knows the directory the survey ends up in.
    reportPath: path.join(path.dirname(evidencePath), 'report.md'),
  }
}
