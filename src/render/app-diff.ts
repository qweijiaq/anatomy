/**
 * The diff, written out.
 *
 * Same rule as the facts report: nothing appears here that is not a field of the
 * diff. The warnings go first, not last, because a diff whose two halves examined
 * different amounts of the application is not a diff — it is two lists, and the
 * reader has to be told that before the numbers, not after.
 */

import type { AppDiff, NamedChange } from '../app/diff.js'

function signed(delta: number): string {
  if (delta === 0) return '—'
  return delta > 0 ? `+${delta}` : String(delta)
}

function list(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join('、')
}

/** Only the names that changed; `kept` is counted, never printed in full. */
function changeLines(change: NamedChange, noun: string): string[] {
  const lines: string[] = []
  if (change.added.length > 0) lines.push(`- 新增 ${change.added.length} 个${noun}：${list(change.added)}`)
  if (change.removed.length > 0)
    lines.push(`- 消失 ${change.removed.length} 个${noun}：${list(change.removed)}`)
  if (change.added.length === 0 && change.removed.length === 0) {
    lines.push(`- ${noun}没有变化（共 ${change.kept.length} 个）`)
  }
  return lines
}

export function renderAppDiff(diff: AppDiff): string {
  const lines: string[] = []

  lines.push(`# ${diff.after.name}：两份分析的差异`)
  lines.push('')
  lines.push(
    `前：\`${diff.before.digest}\` · 后：\`${diff.after.digest}\`${
      diff.sameBuild ? '（**同一个构建**，差异只可能来自分析范围）' : ''
    }`,
  )
  lines.push('')

  if (!diff.comparable) {
    lines.push('## 先看这里：这两份不完全可比')
    lines.push('')
    for (const warning of diff.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('## 暴露面变化')
  lines.push('')
  lines.push('| 项 | 前 | 后 | 变化 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of diff.counters) {
    lines.push(`| ${row.label} | ${row.before} | ${row.after} | ${signed(row.after - row.before)} |`)
  }
  lines.push('')

  lines.push('## IPC 通道')
  lines.push('')
  lines.push(...changeLines(diff.channels, '通道'))
  lines.push('')

  lines.push('## 暴露成员')
  lines.push('')
  lines.push(...changeLines(diff.members, '成员'))
  lines.push('')

  if (diff.pairing.gainedReceiver.length > 0 || diff.pairing.lostReceiver.length > 0) {
    lines.push('## 配对状态变了')
    lines.push('')
    if (diff.pairing.gainedReceiver.length > 0) {
      lines.push(`- 这两次之间找到了接收端：${list(diff.pairing.gainedReceiver)}`)
    }
    if (diff.pairing.lostReceiver.length > 0) {
      lines.push(`- 这两次之间找不到接收端了：${list(diff.pairing.lostReceiver)}`)
    }
    lines.push('')
    lines.push(
      '**配对状态不是通道的属性，是这次分析的属性。** 它变了通常意味着分析范围变了，' +
        '不等于代码里加了或删了 handler。',
    )
    lines.push('')
  }

  if (diff.limitations.added.length > 0 || diff.limitations.removed.length > 0) {
    lines.push('## 「没看的部分」的变化')
    lines.push('')
    if (diff.limitations.added.length > 0) {
      lines.push(`后一份多出 ${diff.limitations.added.length} 条：`)
      lines.push('')
      for (const item of diff.limitations.added) lines.push(`- ${item}`)
      lines.push('')
    }
    if (diff.limitations.removed.length > 0) {
      lines.push(`前一份有、后一份没有 ${diff.limitations.removed.length} 条：`)
      lines.push('')
      for (const item of diff.limitations.removed) lines.push(`- ${item}`)
      lines.push('')
    }
  }

  lines.push('## 这份差异是什么')
  lines.push('')
  lines.push('两份 REA 事实报告的差集，没有模型参与，也没有一句判断。')
  lines.push('「新增了一个能碰到系统的通道」是记录；「这个版本更危险」不是这份文件能说的话。')
  lines.push('')
  lines.push(`前一份证据：\`${diff.before.evidenceId}\``)
  lines.push(`后一份证据：\`${diff.after.evidenceId}\``)
  return `${lines.join('\n')}\n`
}
