/**
 * `ana ask <runId> "question"` — a follow-up that cannot leave the report's evidence.
 *
 * The report is already on disk; asking does not re-analyse and does not read the
 * source tree. It spends one or two model requests, which is why the usage is part
 * of the result rather than a hidden side effect.
 */

import path from 'node:path'

import { readReportInput } from './report.js'
import { createModelClient, MissingCredentialsError, resolveApiKey, type ModelClient } from '../writing/client.js'
import { answerQuestion, type Answer } from '../writing/answer.js'
import type { Lang } from '../writing/prompts/zh.js'
import { resolveModelName } from './analyze.js'

export const ASK_USAGE = `Usage: ana ask <runId> "<question>" [options]

Options:
  --model <name>     Model name (default: $ANA_MODEL or the built-in default)
  --api-key <key>    Overrides $ANA_API_KEY
  --lang <zh|en>     Answer language (default: the report's language)
  --json             Print the answer, citations and usage as JSON
  --dir <path>       Look in this run directory instead of .ana/runs`

export type AskOptions = {
  model?: string
  apiKey?: string
  lang?: Lang
  baseDir?: string
  /** Injected client, so tests never touch the network. */
  client?: ModelClient
}

export type AskArgs =
  | { help: true }
  | { help: false; runId: string; question: string; json: boolean; options: AskOptions }

export class AskUsageError extends Error {}

/** Flags take a value; everything else is the run id and the question, in order. */
export function parseAskArgs(argv: string[]): AskArgs {
  const positional: string[] = []
  const values = new Map<string, string>()
  let json = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token === '--json') {
      json = true
      continue
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
      let value: string
      if (equals !== -1) value = token.slice(equals + 1)
      else {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
          throw new AskUsageError(`--${name} needs a value`)
        }
        value = next
        index += 1
      }
      if (!['model', 'api-key', 'lang', 'dir'].includes(name)) {
        throw new AskUsageError(`unknown option "--${name}"`)
      }
      if (value === '') throw new AskUsageError(`--${name} needs a value`)
      values.set(name, value)
      continue
    }
    positional.push(token)
  }

  if (help) return { help: true }
  const [runId, ...questionParts] = positional
  if (runId === undefined) throw new AskUsageError('ask needs a run id and a question')
  if (questionParts.length === 0) throw new AskUsageError('ask needs a question')
  const question = questionParts.join(' ').trim()
  if (question === '') throw new AskUsageError('ask needs a question')

  const options: AskOptions = {}
  const model = values.get('model')
  if (model !== undefined) options.model = model
  const apiKey = values.get('api-key')
  if (apiKey !== undefined) options.apiKey = apiKey
  const dir = values.get('dir')
  if (dir !== undefined) options.baseDir = path.resolve(dir)
  const lang = values.get('lang')
  if (lang !== undefined) {
    if (lang !== 'zh' && lang !== 'en') throw new AskUsageError(`--lang expects "zh" or "en"`)
    options.lang = lang
  }
  return { help: false, runId, question, json, options }
}

export async function runAsk(
  runId: string,
  question: string,
  opts: AskOptions = {},
): Promise<Answer> {
  const input = await readReportInput(runId, opts.baseDir === undefined ? {} : { baseDir: opts.baseDir })
  const model = resolveModelName(opts.model)
  const apiKey = resolveApiKey(opts.apiKey)
  if (apiKey === '' && opts.client === undefined) throw new MissingCredentialsError()
  const client =
    opts.client ??
    createModelClient({
      model,
      apiKey,
    })
  return answerQuestion({
    client,
    input,
    question,
    lang: opts.lang ?? input.lang ?? 'zh',
  })
}

/** What `ana ask` prints, so the command and its tests share one shape. */
export function formatAsk(answer: Answer): string {
  const lines = [answer.answer]
  if (answer.citations.length > 0) {
    lines.push('', answer.answered ? '引用：' : 'Citations:')
    for (const citation of answer.citations) lines.push(`- ${citation}`)
  }
  return `${lines.join('\n')}\n`
}

/** The JSON shape `--json` prints. Kept here so the command and its tests agree. */
export function askJson(answer: Answer): string {
  return `${JSON.stringify(answer, null, 2)}\n`
}
