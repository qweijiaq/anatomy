// A local stand-in for a model provider, used by `scripts/verify.sh` so the
// whole pipeline can be exercised offline. It answers the two request shapes the
// writing layer sends and echoes a line out of the slice it was given, which is
// what makes the produced citation genuinely checkable.
import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 0)

/** Slice blocks are `--- path:start-end ---` followed by `N | source` lines. */
function pickSnippet(user) {
  const lines = user.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^---\s+(\S+?):(\d+)-(\d+)\s+---$/.exec((lines[i] ?? '').trim())
    if (header === null) continue
    const [, path, startRaw] = header
    let best = null
    let bestLine = Number(startRaw)
    for (let k = i + 1; k < Math.min(lines.length, i + 60); k += 1) {
      const numbered = /^\s*(\d+)\s*\|\s?(.*)$/.exec(lines[k] ?? '')
      if (numbered === null) continue
      const [, numberRaw, code] = numbered
      if (code.trim() === '') continue
      if (best === null || code.trim().length > best.trim().length) {
        best = code
        bestLine = Number(numberRaw)
      }
      if (code.trim().length > 30) break
    }
    if (best !== null) return { path, startLine: bestLine, endLine: bestLine, snippet: best }
  }
  return null
}

function pickTitles(user) {
  const titles = []
  for (const line of user.split('\n')) {
    const match = /^\d+\.\s+(.+)$/.exec(line.trim())
    if (match !== null) titles.push(match[1])
  }
  return titles
}

function judgeReply(user) {
  const found = pickSnippet(user)
  if (found === null) return { skip: true }
  return {
    id: 'verify-point',
    title: '用插入顺序维护淘汰顺序，不额外维护链表',
    kind: 'data-model',
    problem: { constraint: '需要在常数时间内命中并淘汰', stakes: '内存无限增长' },
    alternatives: [{ approach: '定时器定期扫描全部条目', cost: '每个实例一个定时器' }],
    theirs: { summary: '命中时先删再插，淘汰时取最早插入的键', evidence: [found] },
    mechanism: '有序映射保留插入顺序，删除后重新插入即等于移动到队尾',
    tradeoffs: [{ cost: '依赖映射的顺序语义', whenItHurts: '条目极多时删除插入的常数开销上升' }],
    confidence: 'high',
    unknowns: [],
    recipe: null,
  }
}

createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let system = ''
    let user = ''
    try {
      const messages = JSON.parse(body).messages ?? []
      system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n')
      user = messages.filter((m) => m.role !== 'system').map((m) => m.content ?? '').join('\n')
    } catch {
      // An unreadable request still gets a well-formed reply: the point is that
      // the pipeline never has to trust this server.
    }
    const isSynthesis = `${system}\n${user}`.includes('"topFive"')
    const payload = isSynthesis
      ? { problem: '一个小型工具库，用语言内建结构替代显式的数据结构。', topFive: pickTitles(user).slice(0, 5) }
      : judgeReply(user)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    )
  })
}).listen(PORT, '127.0.0.1', function listening() {
  process.stdout.write(`${this.address().port}\n`)
})
