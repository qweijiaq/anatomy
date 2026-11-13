/**
 * Two surveys of one application, compared.
 *
 * This is the question worth asking about a build you did not write: what changed
 * on the boundary between these two versions. It is answerable from facts alone —
 * a channel either exists in both surveys or it does not — so unlike a "design
 * notes" report for a sourceless app, it needs no model and no judgement, and it
 * cannot drift from its evidence.
 *
 * ## The one way this can lie
 *
 * Two surveys are comparable only if they looked at the same amount of the
 * application. A full pass and a `--path preload.cjs` pass over the same build
 * differ by nine channels that never changed; presenting that as a diff would be a
 * fabricated release note. So scope is compared before anything else and, when it
 * differs, the diff says so in front of the numbers rather than after them.
 */

import type { AppSurvey } from './rea.js'

export type NamedChange = { added: string[]; removed: string[]; kept: string[] }

export type CounterChange = { label: string; before: number; after: number }

export type AppDiff = {
  before: { name: string; digest: string; evidenceId: string }
  after: { name: string; digest: string; evidenceId: string }
  /** False when the two surveys did not examine the same amount of the app. */
  comparable: boolean
  /** Why not, in the reader's words. Empty when comparable. */
  warnings: string[]
  /** False when the two surveys describe different builds at all. */
  sameBuild: boolean
  counters: CounterChange[]
  channels: NamedChange
  members: NamedChange
  /** Channels that gained or lost a receiver, by name. */
  pairing: { gainedReceiver: string[]; lostReceiver: string[] }
  limitations: NamedChange
}

/**
 * How many inventoried files a survey left outside its scope, or `null` for a pass
 * that examined everything.
 *
 * REA states this in a limitation rather than a field — `Caller-selected source
 * analysis leaves 4 inventoried files outside analysis scope` — so it is read back
 * out of that sentence. Any other wording means "not a selection", which is the
 * safe default: two unselected passes are always comparable.
 */
export function outOfScope(survey: AppSurvey): number | null {
  for (const item of survey.limitations) {
    const match = /leaves (\d+) inventoried files? outside analysis scope/i.exec(item)
    if (match !== null) return Number(match[1])
  }
  return null
}

function change(before: readonly string[], after: readonly string[]): NamedChange {
  const previous = new Set(before)
  const next = new Set(after)
  return {
    added: after.filter((item) => !previous.has(item)).sort((a, b) => a.localeCompare(b)),
    removed: before.filter((item) => !next.has(item)).sort((a, b) => a.localeCompare(b)),
    kept: after.filter((item) => previous.has(item)).sort((a, b) => a.localeCompare(b)),
  }
}

function allMembers(survey: AppSurvey): string[] {
  const seen = new Set<string>()
  for (const module of survey.modules) {
    if (module.kind !== 'context-bridge-api') continue
    for (const member of module.members) seen.add(member)
  }
  return [...seen]
}

function channelNames(survey: AppSurvey): string[] {
  return survey.pairs.map((pair) => pair.name)
}

function pairingOf(survey: AppSurvey): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const pair of survey.pairs) map.set(pair.name, pair.handled)
  return map
}

const COUNTERS: ReadonlyArray<{ label: string; pick: (survey: AppSurvey) => number }> = [
  { label: '窗口', pick: (s) => s.surface.browserWindows },
  { label: 'preload 入口', pick: (s) => s.surface.preloadEntrypoints },
  { label: 'contextBridge API', pick: (s) => s.surface.contextBridgeApis },
  { label: '暴露成员', pick: (s) => s.surface.exposedApiMembers },
  { label: 'IPC 操作', pick: (s) => s.surface.ipcOperations },
  { label: '字面通道', pick: (s) => s.surface.ipcLiteralChannels },
  { label: '主进程 handler', pick: (s) => s.surface.ipcMainHandlers },
  { label: '未配对发送', pick: (s) => s.surface.ambiguousTransmissions },
  { label: '原生插件绑定', pick: (s) => s.surface.nativeAddonBindings },
  { label: '协议注册', pick: (s) => s.surface.protocolRegistrations },
  { label: '解析的 JS 文件', pick: (s) => s.statistics.parsedJavaScriptFiles },
  { label: '重建出的节点', pick: (s) => s.modules.length },
]

export function diffSurveys(before: AppSurvey, after: AppSurvey): AppDiff {
  const warnings: string[] = []

  const beforeScope = outOfScope(before)
  const afterScope = outOfScope(after)
  if (beforeScope !== afterScope) {
    const describe = (value: number | null): string =>
      value === null ? '全量分析' : `有 ${value} 个文件在范围外`
    warnings.push(
      `两次的分析范围不一样：前一份${describe(beforeScope)}，后一份${describe(afterScope)}。` +
        '下面「消失」的通道可能只是这次没分析到，不是真的没了。',
    )
  }
  if (before.retried !== after.retried) {
    warnings.push(
      before.retried
        ? '前一份因为 worker 堆耗尽自动缩小过范围，后一份没有——数字差异里包含这个原因。'
        : '后一份因为 worker 堆耗尽自动缩小过范围，前一份没有——数字差异里包含这个原因。',
    )
  }

  const pairingBefore = pairingOf(before)
  const pairingAfter = pairingOf(after)
  const gainedReceiver: string[] = []
  const lostReceiver: string[] = []
  for (const [name, handled] of pairingAfter) {
    const was = pairingBefore.get(name)
    if (was === undefined) continue
    if (!was && handled) gainedReceiver.push(name)
    if (was && !handled) lostReceiver.push(name)
  }

  return {
    before: { name: before.name, digest: before.digest, evidenceId: before.evidenceId },
    after: { name: after.name, digest: after.digest, evidenceId: after.evidenceId },
    comparable: warnings.length === 0,
    warnings,
    sameBuild: before.digest === after.digest && before.digest !== '',
    counters: COUNTERS.map(({ label, pick }) => ({
      label,
      before: pick(before),
      after: pick(after),
    })),
    channels: change(channelNames(before), channelNames(after)),
    members: change(allMembers(before), allMembers(after)),
    pairing: { gainedReceiver: gainedReceiver.sort(), lostReceiver: lostReceiver.sort() },
    limitations: change(before.limitations, after.limitations),
  }
}

/** True when nothing the report would print has changed. */
export function isEmptyDiff(diff: AppDiff): boolean {
  return (
    diff.counters.every((row) => row.before === row.after) &&
    diff.channels.added.length === 0 &&
    diff.channels.removed.length === 0 &&
    diff.members.added.length === 0 &&
    diff.members.removed.length === 0 &&
    diff.pairing.gainedReceiver.length === 0 &&
    diff.pairing.lostReceiver.length === 0
  )
}
