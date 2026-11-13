/**
 * The facts report: an application, described without a model and without a claim.
 *
 * Every other report this product writes contains prose a model wrote and a
 * verifier checked against the bytes on disk. This one contains neither. There is
 * no source to quote, so there is nothing to verify — which means the only honest
 * report is one that repeats REA's records and adds nothing to them.
 *
 * The rule for this file, therefore: a statement may appear if and only if it can
 * be read off a field. "The renderer can call `settings.save`" is a record. "The
 * IPC surface is too large" is a judgement, and judgements belong in the report
 * that has a verifier behind it, not here.
 *
 * What that buys is a document that is wrong only if REA is wrong, and whose every
 * paragraph can be checked by opening one JSON file.
 */

import type { AppSurvey } from '../app/rea.js'

const GROUP_LABEL: ReadonlyArray<{ key: keyof AppSurvey['groups']['channels']; label: string }> = [
  { key: 'privileged', label: '能碰到系统' },
  { key: 'write', label: '会改东西' },
  { key: 'read', label: '只读' },
  { key: 'event', label: '事件' },
  { key: 'other', label: '看不出' },
]

/** Numbers that are only meaningful next to their explanation. */
function surfaceRows(survey: AppSurvey): Array<[string, number]> {
  const s = survey.surface
  return [
    ['窗口', s.browserWindows],
    ['preload 入口', s.preloadEntrypoints],
    ['contextBridge API', s.contextBridgeApis],
    ['暴露成员', s.exposedApiMembers],
    ['IPC 操作', s.ipcOperations],
    ['字面通道', s.ipcLiteralChannels],
    ['主进程 handler', s.ipcMainHandlers],
    ['渲染进程发送', s.rendererTransmissions],
    ['渲染进程监听', s.rendererListeners],
    ['未配对发送', s.ambiguousTransmissions],
    ['sender 校验观察', s.senderValidationObservations],
    ['原生插件绑定', s.nativeAddonBindings],
    ['协议注册', s.protocolRegistrations],
  ]
}

function bridges(survey: AppSurvey): Array<{ name: string; members: string[] }> {
  return survey.modules
    .filter((module) => module.kind === 'context-bridge-api')
    .map((module) => ({ name: module.label, members: module.members }))
}

/**
 * Channels the renderer sends on but no receiver was found for.
 *
 * Named rather than counted, and immediately qualified: a missing `handles` edge is
 * a missing observation, not an unhandled channel. The analysis may simply not have
 * read the file that registers the handler — which, for a bundle past the worker
 * heap, is the common case.
 */
function unpaired(survey: AppSurvey): string[] {
  return survey.pairs.filter((pair) => !pair.handled).map((pair) => pair.name)
}

export function renderAppReport(survey: AppSurvey): string {
  const lines: string[] = []
  const rows = surfaceRows(survey)
  const unpairedChannels = unpaired(survey)

  lines.push(`# ${survey.name}`)
  lines.push('')
  lines.push('## 这份报告是什么')
  lines.push('')
  lines.push(
    '这是一份**事实报告**：从打包产物静态重建，没有源码，没有模型参与，也没有一句判断。',
  )
  lines.push('')
  lines.push(
    '下面每一条都能在证据文件里找到对应字段。所以它只会在 REA 错的时候错，' +
      '而每一个结论都可以打开那份 JSON 复核。',
  )
  lines.push('')

  lines.push('## 分析口径')
  lines.push('')
  lines.push(`- 目标：\`${survey.target}\``)
  lines.push(`- 形态：${survey.format} · 摘要 \`${survey.digest}\``)
  lines.push(
    `- 规模：${survey.statistics.relevantFiles} 个文件 / 解析 ${survey.statistics.parsedJavaScriptFiles} 个 JS / ` +
      `${survey.statistics.visitedAstNodes} 个 AST 节点`,
  )
  lines.push(
    `- 事实：${survey.statistics.findings} 条 · 解析失败 ${survey.statistics.parseFailures} 个`,
  )
  lines.push(`- 证据：\`${survey.evidenceId}\``)
  lines.push(`- 可信度：${survey.confidence} · 权威性：${survey.authority}`)
  lines.push('')

  if (survey.retried) {
    lines.push('## 自动缩小过范围')
    lines.push('')
    lines.push(survey.retryNote)
    lines.push('')
  }

  lines.push('## Electron 暴露面')
  lines.push('')
  lines.push('| 项 | 数量 |')
  lines.push('| --- | --- |')
  for (const [label, value] of rows) lines.push(`| ${label} | ${value} |`)
  lines.push('')
  lines.push(
    `语义覆盖是 \`${survey.surface.semantics}\`。不是 \`complete\` 时，上面每个数字都是**下界**，` +
      '不是全貌——这一句比表格里的数字重要。',
  )
  lines.push('')

  const bridgeList = bridges(survey)
  if (bridgeList.length > 0) {
    lines.push('## 渲染进程拿到了什么')
    lines.push('')
    for (const bridge of bridgeList) {
      lines.push(`通过 \`${bridge.name}\` 暴露了 ${bridge.members.length} 个成员：`)
      lines.push('')
      for (const member of bridge.members) lines.push(`- \`${member}\``)
      lines.push('')
    }
  }

  const grouped = survey.groups.channels
  const hasChannels = GROUP_LABEL.some(({ key }) => grouped[key].length > 0)
  if (hasChannels) {
    lines.push('## IPC 通道')
    lines.push('')
    lines.push('按名字分组。**分组只读名字**，不是安全判定：它不知道 handler 有没有校验发送方，也不知道拿到参数后做了什么。')
    lines.push('')
    for (const { key, label } of GROUP_LABEL) {
      const names = grouped[key]
      if (names.length === 0) continue
      lines.push(`**${label}**（${names.length}）：${names.map((name) => `\`${name}\``).join('、')}`)
      lines.push('')
    }
  }

  if (unpairedChannels.length > 0) {
    lines.push('## 只看到发送、没看到接收端')
    lines.push('')
    lines.push(`${unpairedChannels.length} 条：${unpairedChannels.map((name) => `\`${name}\``).join('、')}`)
    lines.push('')
    lines.push(
      '**「没找到接收端」不等于「没有接收端」。** 它只说明这次分析没有读到注册 handler 的代码——' +
        '主进程入口没被分析时，这几乎必然发生。要回答它到底有没有人处理，得去读那个文件。',
    )
    lines.push('')
  }

  if (survey.modules.length > 0) {
    const kinds = new Map<string, number>()
    for (const module of survey.modules) kinds.set(module.kind, (kinds.get(module.kind) ?? 0) + 1)
    lines.push('## 重建出的图')
    lines.push('')
    lines.push(`- ${survey.modules.length} 个节点：${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join('、')}`)
    lines.push(
      `- ${survey.pairs.length} 条通道，其中 ${survey.pairs.filter((pair) => pair.handled).length} 条有接收端`,
    )
    lines.push('')
  } else if (survey.graphOmitted !== '') {
    lines.push('## 图没有载入')
    lines.push('')
    lines.push(survey.graphOmitted)
    lines.push('')
  }

  lines.push(`## 没看的部分（${survey.limitations.length} 条）`)
  lines.push('')
  lines.push('REA 原话，没有改写。数字要连着这里读。')
  lines.push('')
  for (const item of survey.limitations) lines.push(`- ${item}`)
  lines.push('')
  lines.push(`证据文件：\`${survey.evidenceFile}\``)
  return `${lines.join('\n')}\n`
}
