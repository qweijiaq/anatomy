/**
 * `ana resume <runId>` — continue a run that stopped in the expensive stage.
 *
 * The judge writes a checkpoint after every candidate. A resumed run re-acquires
 * the same tree (same source, ref and subpath), skips the candidates already
 * judged, and finishes into a **new** run directory: the old one is a record of
 * what happened, including its failure, and rewriting it in place would make the
 * interrupted attempt unreadable.
 *
 * The reused points are copied, not trusted: the normal validator checks their
 * citations against the re-acquired tree before any of them reaches the page.
 */

import path from 'node:path'

import type { LearningPoint } from '../contracts/types.js'
import { DEFAULT_RUNS_DIR } from '../kernel/pipeline.js'
import { isArtifactName, readRunArtifact, readManifest } from '../store/runs.js'
import type { SkippedCandidate } from '../writing/judge.js'
import type { Lang } from '../writing/prompts/zh.js'
import type { ModelClient } from '../writing/client.js'
import { runAnalyze, type AnalyzeResult } from './analyze.js'

export const RESUME_USAGE = `Usage: ana resume <runId> [options]

Options:
  --model <name>     Override the model recorded by the interrupted run
  --api-key <key>    Overrides $ANA_API_KEY
  --max-tokens <n>   Whole-run token ceiling for the resumed attempt
  --json             Print the JSON report instead of the markdown path
  --dir <path>       Look in this run directory instead of .ana/runs`

export type ResumeProgress = {
  v: 1
  runId: string
  source: string
  ref: string
  subpath: string
  lang: Lang
  model: string
  top?: number
  reportPoints?: number
  maxTokens?: number
  done: string[]
  points: LearningPoint[]
  skipped: SkippedCandidate[]
  replyFailures: number
  usage?: { in: number; out: number }
  updatedAt: string
}

export type ResumeOptions = {
  model?: string
  apiKey?: string
  maxTokens?: number
  baseDir?: string
  client?: ModelClient
}

export type ResumeResult = AnalyzeResult & { reused: number }

export class ResumeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResumeUnavailableError'
  }
}

/** The checkpoint of one run, or a message that says why there is nothing to resume. */
export async function loadResumeProgress(
  runId: string,
  baseDir = path.resolve(DEFAULT_RUNS_DIR),
): Promise<ResumeProgress> {
  if (!isArtifactName(runId)) {
    throw new ResumeUnavailableError(`"${runId}" is not a run id`)
  }
  const progress = await readRunArtifact<ResumeProgress>(baseDir, runId, 'judge-progress')
  if (progress === null || progress.v !== 1 || !Array.isArray(progress.done)) {
    throw new ResumeUnavailableError(
      `run ${runId} has no judge checkpoint; only a run interrupted during judging can be resumed`,
    )
  }
  const manifest = await readManifest(baseDir, runId)
  if (manifest === null) throw new ResumeUnavailableError(`run ${runId} has no manifest`)
  if (manifest.status === 'complete') {
    throw new ResumeUnavailableError(`run ${runId} is already complete; use ` + '`ana report`')
  }
  return progress
}

/**
 * Continues into a new run, reusing the judged candidates and re-checking them.
 *
 * The returned `reused` is the count of candidates that will not be paid for again;
 * it is reported to the user because "resumed" without a number is a claim, not a
 * receipt.
 */
export async function runResume(
  runId: string,
  opts: ResumeOptions = {},
): Promise<ResumeResult> {
  const baseDir = path.resolve(opts.baseDir ?? DEFAULT_RUNS_DIR)
  const progress = await loadResumeProgress(runId, baseDir)
  const result = await runAnalyze(progress.source, {
    ...(opts.model === undefined ? { model: progress.model } : { model: opts.model }),
    ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }),
    ...(opts.maxTokens === undefined
      ? progress.maxTokens === undefined
        ? {}
        : { maxTokens: progress.maxTokens }
      : { maxTokens: opts.maxTokens }),
    ...(progress.top === undefined ? {} : { top: progress.top }),
    ...(progress.reportPoints === undefined ? {} : { reportPoints: progress.reportPoints }),
    ref: progress.ref === '' ? undefined : progress.ref,
    subpath: progress.subpath === '' ? undefined : progress.subpath,
    lang: progress.lang,
    baseDir,
    ...(opts.client === undefined ? {} : { client: opts.client }),
    resume: {
      done: progress.done,
      points: progress.points,
      skipped: progress.skipped,
      replyFailures: progress.replyFailures,
    },
  })
  return { ...result, reused: progress.done.length }
}

/** The JSON shape the CLI prints; also a receipt for the old run id. */
export function resumeJson(result: ResumeResult): string {
  return `${JSON.stringify(
    {
      runId: result.runId,
      reportPath: result.reportPath,
      reused: result.reused,
      usage: result.usage,
    },
    null,
    2,
  )}\n`
}

export type ResumeArgs =
  | { help: true }
  | { help: false; runId: string; json: boolean; options: ResumeOptions }

export class ResumeUsageError extends Error {}

export function parseResumeArgs(argv: string[]): ResumeArgs {
  const positional: string[] = []
  const options: ResumeOptions = {}
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
          throw new ResumeUsageError(`--${name} needs a value`)
        }
        value = next
        index += 1
      }
      if (value === '') throw new ResumeUsageError(`--${name} needs a value`)
      if (name === 'model') options.model = value
      else if (name === 'api-key') options.apiKey = value
      else if (name === 'dir') options.baseDir = path.resolve(value)
      else if (name === 'max-tokens') {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new ResumeUsageError('--max-tokens expects a positive integer')
        }
        options.maxTokens = parsed
      } else throw new ResumeUsageError(`unknown option "--${name}"`)
      continue
    }
    positional.push(token)
  }

  if (help) return { help: true }
  const [runId, ...rest] = positional
  if (runId === undefined) throw new ResumeUsageError('resume needs a run id')
  if (rest.length > 0) throw new ResumeUsageError(`unexpected argument "${rest[0]}"`)
  return { help: false, runId, json, options }
}
