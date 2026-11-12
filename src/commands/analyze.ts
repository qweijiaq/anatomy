/**
 * `ana analyze`: the whole product, in the order that makes each stage's answer
 * cheap for the next one.
 *
 *   scan (no model) -> fit the batch to a token budget -> judge each candidate
 *   -> rank the surviving points -> synthesise the brief -> render -> persist
 *
 * The order is the design. `scan` decides *where* to look with no tokens at all;
 * `fitCandidates` spends the budget on the highest-scoring candidates and counts
 * what it could not afford; the judge is the only stage that reads code and the
 * only one that spends the real budget; the ranking runs on validated points, so
 * the top five cannot be won by a claim whose citation was thrown away; the
 * synthesiser sees titles and never code, so it cannot invent a point the report
 * does not contain.
 *
 * Two consequences of that order live in this file:
 *
 * - the scan is asked to `keepTree`, because the judge slices evidence out of
 *   the tree and the tree is deleted by `closeRun` at the end of the run — after
 *   the report is on disk, in a `finally`, so an interrupted analysis leaves the
 *   artifacts and not the copy of the repository;
 * - every candidate the run did not look at is named. `fitCandidates` reports a
 *   count, but a count is not an audit trail, so the cut candidates are recovered
 *   by identity and joined with the judge's own skip list and the synthesis
 *   outcome. The report tail then states the gaps instead of the page reading as
 *   if nothing was left out.
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Candidate, LearningPoint, ReportInput, ValidationResult } from '../contracts/types.js'
import { DEFAULT_BUDGET_TOKENS } from '../contracts/types.js'
import type { AcquireDeps } from '../kernel/acquire.js'
import { clampBudget, fitCandidates } from '../kernel/budget.js'
import { scanRepo } from '../kernel/pipeline.js'
import { renderJson } from '../render/json.js'
import { renderMarkdown } from '../render/markdown.js'
import type { Run } from '../store/runs.js'
import { closeRun } from '../store/runs.js'
import type { ModelClient } from '../writing/client.js'
import { createModelClient, DEFAULT_MODEL } from '../writing/client.js'
import { buildJudgePrompt, judgeCandidates } from '../writing/judge.js'
import type { Lang } from '../writing/prompts/zh.js'
import { rankPoints } from '../writing/rank.js'
import { synthesize, type Synthesis } from '../writing/synthesis.js'

/** The page the reader opens. The only artifact that is not JSON. */
export const REPORT_FILE = 'report.md'

/**
 * The reason stored for a candidate the budget could not afford.
 *
 * A constant because it is a promise to the reader: the same string appears in
 * `skipped.json`, in the report tail and in the budget summary line, so the three
 * cannot drift into three descriptions of one gap.
 */
export const BUDGET_CUT_REASON = 'cut by token budget'

/**
 * Characters of code a candidate's slices are assumed to cost.
 *
 * `fitCandidates` takes a *synchronous* cost function, and the judge's slices
 * come from disk (its own window plus two dependency heads), so this cannot be
 * the real prompt. It is the real prompt's fixed half plus a conservative stand-in
 * for the slices: the judge's own `buildJudgePrompt` builds the system prompt and
 * the candidate header, so those characters are measured rather than guessed, and
 * the user half is padded with the densest possible text at the worst-case window
 * size (72 lines x ~110 characters). Dense text costs the estimator the *most*
 * tokens per character, so the estimate errs high: it can cut one candidate too
 * many, never one too few.
 */
const SLICE_COST_CHARS = 8_000
const SLICE_PADDING = 'x'.repeat(SLICE_COST_CHARS)

export type AnalyzeOptions = {
  /** Model name; also what the budget is clamped against. */
  model?: string
  /** Overrides `ANA_API_KEY`. Ignored when `client` is given. */
  apiKey?: string
  /** How many candidates the scan may produce. */
  top?: number
  /** Per-request token budget, before `clampBudget` narrows it to the model. */
  budget?: number
  /** Prompt language; `zh` is the shipped default. */
  lang?: Lang
  subpath?: string
  ref?: string
  /** Run directory parent. Defaults to `<cwd>/.ana/runs`. */
  baseDir?: string
  /** Injected client, so tests (and a caller with its own gateway) skip the network. */
  client?: ModelClient
  /**
   * Injected acquisition dependencies, so tests never touch the network.
   *
   * The task brief calls this `AcquisitionDeps`; the kernel exports it as
   * `AcquireDeps`, and that is what is used here.
   */
  deps?: AcquireDeps
}

export type AnalyzeResult = { runId: string; reportPath: string }

/**
 * One thing the run did not look at, or looked at and could not use.
 *
 * `path` and `line` are the candidate's, so a gap can be found in the tree. A
 * run-level gap — the synthesis outcome — names no file, and carries the empty
 * path and line 0 rather than a path that would resolve to nothing.
 */
export type AnalyzeSkip = { path: string; line: number; reason: string }

/**
 * The context `fitCandidates` costs one candidate by.
 *
 * Built from the judge's own prompt builder, not a copy of it: the batch is fitted
 * against the prompt that will actually be sent, so the estimate cannot drift away
 * from the request. The slices are the part that cannot be reproduced here; see
 * `SLICE_COST_CHARS`.
 */
function candidateContext(candidate: Candidate, lang: Lang): { system: string; user: string } {
  const prompt = buildJudgePrompt(candidate, [], lang)
  return { system: prompt.system, user: `${prompt.user}\n${SLICE_PADDING}` }
}

/** `path:line` for a candidate, the citation form the rest of the product uses. */
function locationOf(candidate: { path: string; line: number }): string {
  return `${candidate.path}:${candidate.line}`
}

/** What the synthesis stage actually did, in one line the reader can check. */
function synthesisGap(synthesis: Synthesis, ranked: number): string {
  return `synthesis chose ${synthesis.topFive.length} of ${ranked} ranked points`
}

/**
 * The gaps as prose, for the report tail: a count first, because a reader can act
 * on a number, then one line per candidate so the number is auditable.
 */
function skipLines(skipped: AnalyzeSkip[], cut: number, budget: number): string[] {
  const lines: string[] = []
  if (cut > 0) lines.push(`${cut} candidates ${BUDGET_CUT_REASON} (${budget} tokens)`)
  for (const entry of skipped) {
    lines.push(entry.path === '' ? entry.reason : `${locationOf(entry)} ${entry.reason}`)
  }
  return lines
}

/**
 * Writes every artifact of the run, `report.md` last.
 *
 * `report.md` is the last write because it is the only artifact a reader opens
 * directly: a page that exists means the points, the trust numbers and the gap
 * list beside it were already on disk. `run.write` appends `.json` and re-stringifies
 * under an atomic rename, so the rendered JSON document is parsed back and stored
 * as a document rather than as a JSON string inside a JSON file.
 */
async function persist(
  run: Run,
  report: ReportInput,
  points: LearningPoint[],
  validation: ValidationResult,
  synthesis: Synthesis,
  skipped: AnalyzeSkip[],
): Promise<string> {
  const renderedJson = renderJson(report)
  const renderedMarkdown = renderMarkdown(report)

  await run.write('points', points)
  await run.write('validation', validation)
  await run.write('synthesis', synthesis)
  await run.write('skipped', skipped)
  await run.write('report', JSON.parse(renderedJson) as unknown)

  const reportPath = path.join(run.dir, REPORT_FILE)
  await writeFile(reportPath, renderedMarkdown, 'utf8')
  return reportPath
}

/**
 * Analyses `input` end to end and returns the run id and the page.
 *
 * A caller-supplied `client` overrides the default one entirely — that is how the
 * tests avoid the network, and how a caller with its own gateway avoids the key
 * check. Everything else is the pipeline's own default.
 */
export async function runAnalyze(
  input: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const lang: Lang = opts.lang ?? 'zh'
  const model = opts.model ?? DEFAULT_MODEL

  const scanned = await scanRepo(input, {
    subpath: opts.subpath,
    ref: opts.ref,
    topK: opts.top,
    baseDir: opts.baseDir,
    // The judge reads the tree; `closeRun` deletes it once the report is written.
    keepTree: true,
    deps: opts.deps,
  })

  try {
    const client = opts.client ?? createModelClient({ model, apiKey: opts.apiKey })
    const budget = clampBudget(opts.budget ?? DEFAULT_BUDGET_TOKENS, model)
    const fitted = fitCandidates(
      scanned.candidates,
      (candidate) => candidateContext(candidate, lang),
      budget,
    )

    // `fitted.dropped` is the count; the identities are what a reader needs, and
    // `fitCandidates` keeps the same objects, so the cut set is recoverable.
    const affordable = new Set<Candidate>(fitted.kept)
    const cut = scanned.candidates.filter((candidate) => !affordable.has(candidate))

    const judged = await judgeCandidates({
      client,
      root: scanned.root,
      candidates: fitted.kept,
      scope: scanned.scope,
      lang,
      runId: scanned.runId,
      // The budget already decided how many candidates there are; the judge must
      // not add a second, invisible cut on top of it.
      limit: fitted.kept.length,
    })

    // Ranked after validation, so a point whose evidence was thrown away cannot
    // take a top-five slot from a point that has some.
    const points = rankPoints(judged.points, fitted.kept)
    const synthesis = await synthesize({
      client,
      profile: scanned.profile,
      structure: scanned.structure,
      titles: points.map((point) => point.title),
      lang,
    })

    const skipped: AnalyzeSkip[] = [
      ...cut.map((candidate) => ({
        path: candidate.path,
        line: candidate.line,
        reason: BUDGET_CUT_REASON,
      })),
      ...judged.skipped.map((entry) => ({
        path: entry.path,
        line: entry.line,
        reason: entry.reason,
      })),
      { path: '', line: 0, reason: synthesisGap(synthesis, points.length) },
    ]

    const report: ReportInput = {
      problem: synthesis.problem,
      topFive: synthesis.topFive,
      points,
      validation: judged.validation,
      profile: scanned.profile,
      scope: scanned.scope,
      skipped: skipLines(skipped, cut.length, budget),
    }

    const reportPath = await persist(
      scanned.run,
      report,
      points,
      judged.validation,
      synthesis,
      skipped,
    )

    return { runId: scanned.runId, reportPath }
  } finally {
    // The artifacts are the run; the tree is only how the judge reached them.
    await closeRun(scanned.run)
  }
}
