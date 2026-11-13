/**
 * `ana inspect-app <dir>` — what an application looks like from the outside.
 *
 * The command exists because anatomy's other four all require source. An Electron
 * app that ships as a bundle does not have any, so the only honest thing to do is
 * say so and hand the question to REA, which reconstructs the same facts from the
 * artifacts. What comes back is a survey: the Electron surface, what REA could not
 * see, and the module graph.
 *
 * No model is called. This is the zero-token half of the pipeline, exactly like
 * `ana scan`: it tells you where to look before anything costs money.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ReaUnavailableError, surveyApplication, type AppSurvey } from '../app/rea.js'

export const INSPECT_APP_USAGE = `Usage: ana inspect-app <dir> [options]

Statically reconstruct a JavaScript/Electron application with REA — no source needed,
no model called.

Options:
  --out <dir>     Where the survey and the evidence file go (default: .ana/apps/<digest>)
  --json          Print the survey instead of the summary`

export type InspectAppArgs =
  | { help: true }
  | { help: false; target: string; out?: string; json: boolean }

class InspectAppUsageError extends Error {}

export function parseInspectAppArgs(argv: string[]): InspectAppArgs {
  const positional: string[] = []
  let out: string | undefined
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') return { help: true }
    if (token === '--json') {
      json = true
      continue
    }
    if (token === '--out') {
      const value = argv[index + 1]
      if (value === undefined) throw new InspectAppUsageError('--out 需要一个目录')
      out = value
      index += 1
      continue
    }
    if (token.startsWith('--')) throw new InspectAppUsageError(`未知参数 ${token}`)
    positional.push(token)
  }

  if (positional.length !== 1) throw new InspectAppUsageError('需要一个应用目录')
  return { help: false, target: positional[0] as string, ...(out === undefined ? {} : { out }), json }
}

/** A filesystem-safe directory name for one analysis. */
function slugOf(target: string, digest: string): string {
  const base = path.basename(path.resolve(target)).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `${base === '' ? 'app' : base}-${digest === '' ? 'unknown' : digest}`
}

function lines(survey: AppSurvey): string[] {
  const s = survey.surface
  const out: string[] = []
  out.push(`${survey.name}  ${survey.format}  ${survey.digest}`)
  out.push(
    `  ${survey.statistics.relevantFiles} 个文件 / 解析 ${survey.statistics.parsedJavaScriptFiles} 个 JS / ` +
      `${survey.statistics.findings} 条事实`,
  )
  out.push('')
  out.push('Electron 暴露面')
  out.push(`  窗口 ${s.browserWindows} · preload ${s.preloadEntrypoints} · contextBridge ${s.contextBridgeApis} 个 API / ${s.exposedApiMembers} 个成员`)
  out.push(`  IPC ${s.ipcOperations} 个操作 · ${s.ipcLiteralChannels} 条字面通道 · 未配对 ${s.ambiguousTransmissions} 条`)
  if (s.nativeAddonBindings > 0) out.push(`  原生插件绑定 ${s.nativeAddonBindings}`)
  if (s.protocolRegistrations > 0) out.push(`  协议注册 ${s.protocolRegistrations}`)
  out.push(`  语义覆盖 ${s.semantics}`)
  out.push('')

  if (survey.modules.length > 0) {
    const byKind = new Map<string, number>()
    for (const module of survey.modules) byKind.set(module.kind, (byKind.get(module.kind) ?? 0) + 1)
    const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`)
    const byRelation = new Map<string, number>()
    for (const relation of survey.relations) {
      byRelation.set(relation.relation, (byRelation.get(relation.relation) ?? 0) + 1)
    }
    const rel = [...byRelation.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`)
    out.push(`模块图  ${survey.modules.length} 节点 / ${survey.relations.length} 边`)
    out.push(`  ${kinds.join('、')}`)
    out.push(`  ${rel.join('、')}`)
  } else if (survey.graphOmitted !== '') {
    out.push('模块图  未载入')
    out.push(`  ${survey.graphOmitted}`)
  }
  out.push('')

  out.push(`没看的部分（${survey.limitations.length} 条，REA 原话）`)
  for (const item of survey.limitations) out.push(`  - ${item}`)
  out.push('')
  out.push(`证据  ${survey.evidenceId}`)
  out.push(`文件  ${survey.evidenceFile}`)
  return out
}

export async function runInspectApp(args: InspectAppArgs): Promise<void> {
  if (args.help) {
    process.stdout.write(`${INSPECT_APP_USAGE}\n`)
    return
  }

  const target = path.resolve(args.target)
  const outDir = args.out === undefined ? null : path.resolve(args.out)

  let survey: AppSurvey
  try {
    survey = await surveyApplication(target, {
      outputDir: outDir ?? path.join(process.cwd(), '.ana', 'apps', 'staging'),
    })
  } catch (error) {
    if (error instanceof ReaUnavailableError) {
      process.stderr.write(`ana: ${error.message}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }

  // The digest names the analysis, so the directory is renamed once it is known.
  const finalDir = outDir ?? path.join(process.cwd(), '.ana', 'apps', slugOf(target, survey.digest))
  if (outDir === null) {
    await mkdir(path.dirname(finalDir), { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(path.join(process.cwd(), '.ana', 'apps', 'staging'), finalDir)
    survey = {
      ...survey,
      evidenceFile: path.join(finalDir, 'rea-evidence.json'),
    }
  }
  await writeFile(path.join(finalDir, 'survey.json'), JSON.stringify(survey, null, 2))

  if (args.json) {
    process.stdout.write(`${JSON.stringify(survey, null, 2)}\n`)
    return
  }
  process.stdout.write(`${lines(survey).join('\n')}\n`)
}
