/**
 * What a candidate's prompt costs at different context windows.
 *
 * The judge sends one request per candidate. This drives the real prompt builder
 * and the real slice reader with a client that records the estimated tokens and
 * answers "skip", so the numbers are the actual prompts a provider would receive —
 * no model call, no provider key.
 *
 * It measures cost, not quality. A tighter window is cheaper by construction;
 * whether it still shows the model the deciding lines is a question for a real
 * run and a reader.
 */
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('./ts-resolve.mjs', import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const { estimateTokens } = await import('../src/kernel/budget.js')
const { scanRepo } = await import('../src/kernel/pipeline.js')
const { closeRun } = await import('../src/store/runs.js')
const { judgeCandidates } = await import('../src/writing/judge.js')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

const target = process.argv[2] ?? 'https://github.com/sindresorhus/p-queue'
const top = Number(process.argv[3] ?? '12')
const baseDir = mkdtempSync(path.join(tmpdir(), 'ana-cost-'))

const WINDOWS = [
  { name: 'current', window: { before: 12, after: 60, dependencies: 2, dependencyHead: 60 } },
  { name: 'medium', window: { before: 8, after: 48, dependencies: 1, dependencyHead: 48 } },
  { name: 'tight', window: { before: 6, after: 32, dependencies: 1, dependencyHead: 32 } },
  { name: 'minimal', window: { before: 4, after: 20, dependencies: 0, dependencyHead: 0 } },
]

const scanned = await scanRepo(target, { topK: top, baseDir, keepTree: true })
const rows: string[] = []

for (const preset of WINDOWS) {
  let requests = 0
  let tokens = 0
  const client = {
    async complete(request: { system: string; user: string }) {
      requests += 1
      tokens += estimateTokens(request)
      return { json: { skip: true }, usage: { in: 0, out: 0 } }
    },
  }
  await judgeCandidates({
    client,
    root: scanned.root,
    candidates: scanned.candidates,
    scope: scanned.scope,
    runId: `cost-${preset.name}`,
    window: preset.window,
  })
  rows.push(
    `${preset.name.padEnd(8)} ${String(requests).padStart(3)} requests  ${String(tokens).padStart(8)} tokens  ${
      requests === 0 ? '—' : Math.round(tokens / requests)
    } / candidate`,
  )
}

await closeRun(scanned.run)
process.stdout.write(`${target} · ${scanned.candidates.length} candidates\n${rows.join('\n')}\n`)
