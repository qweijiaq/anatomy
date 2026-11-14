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
 *
 * Two more follow from what each stage costs:
 *
 * - the key is checked and the budget clamped before the scan, so a keyless run
 *   fails for free instead of after a download and an extraction;
 * - the judged artifacts are written before synthesis and a synthesis failure is
 *   caught, because the judge is the stage that spends the budget: a 5xx in the
 *   last request must not discard a run that already paid for every judgement.
 *   The synthesiser is offered only the titles the page will render, so the TOP
 *   list cannot name a claim the body withholds.
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  Candidate,
  LearningPoint,
  ReportInput,
  RunManifest,
  ValidationResult,
} from '../contracts/types.js'
import { DEFAULT_BUDGET_TOKENS } from '../contracts/types.js'
import type { AcquireDeps } from '../kernel/acquire.js'
import { clampBudget, fitCandidates } from '../kernel/budget.js'
import { scanRepo } from '../kernel/pipeline.js'
import { normalizeEvidence, renderJson } from '../render/json.js'
import { renderMarkdown } from '../render/markdown.js'
import type { Run } from '../store/runs.js'
import { closeRun } from '../store/runs.js'
import type { ModelClient } from '../writing/client.js'
import {
  createModelClient,
  DEFAULT_MODEL,
  MissingCredentialsError,
  resolveApiKey,
} from '../writing/client.js'
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

/**
 * `--model`, then `$ANA_MODEL`, then the built-in default — the order the usage text
 * has always promised, and which did not hold.
 *
 * This line used to read `opts.model ?? DEFAULT_MODEL` and hand the result to
 * `createModelClient` as an explicit value, so the client's own fallback to
 * `$ANA_MODEL` never ran: every run used `gpt-4o-mini` whatever the environment said.
 * Pointed at DeepSeek that is HTTP 400 ("you passed gpt-4o-mini") once per candidate,
 * and the report came back empty with nothing saying why.
 */
export function resolveModelName(explicit: string | undefined): string {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const fromEnv = process.env['ANA_MODEL']
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : DEFAULT_MODEL
}

export type AnalyzeOptions = {
  /** Model name; also what the budget is clamped against. */
  model?: string
  /** Overrides `ANA_API_KEY`. Ignored when `client` is given. */
  apiKey?: string
  /** How many candidates the scan may produce. */
  top?: number
  /**
   * How many points the report's top list may hold. Defaults to five.
   *
   * Kept separate from `top`: the scan collects candidates to choose between, and
   * this is how many of them the reader wants written up. One number cannot serve
   * both — a scan of eight that may report only five is the shape that made a good
   * candidate set look like a thin report.
   */
  reportPoints?: number
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
   * Progress for a UI. Everything here is advisory: a stage that never fires it
   * still produces the same report, so a dropped callback cannot change output.
   */
  onStage?: (stage: AnalyzeStage) => void
  /**
   * What the provider said when a request failed. The run's artifacts record the
   * status code only; this is for whatever surface the caller owns.
   */
  onProviderError?: (detail: { status: number | null; excerpt: string }) => void
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
 * Where an analysis currently is.
 *
 * `done`/`total` are set on the two stages that take one model call per item, so
 * a caller can show a bar rather than a spinner that never moves.
 */
export type AnalyzeStage = {
  stage: 'acquire' | 'judge' | 'rank' | 'synthesise' | 'report'
  detail?: string
  done?: number
  total?: number
}

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

/** What a redacted fragment reads as: it was there, and it is not legible. */
const REDACTED = '[redacted]'

/**
 * Longest `reason` persisted. A provider's error text can run to a page, and both
 * `skipped.json` and the report tail carry one line per candidate.
 */
const MAX_REASON_CHARS = 200

/**
 * Fragments that make a `reason` a credential rather than an explanation.
 *
 * The judge is handed provider error text, and a provider that echoes the failed
 * request puts the key in it — in a query string, in an echoed header, or bare.
 * The reasons are written to `skipped.json` and printed in the report, so they are
 * the one place a key would end up on disk. The patterns err towards redacting:
 * an unreadable reason is recoverable, a leaked key is not.
 */
const CREDENTIALS: ReadonlyArray<readonly [RegExp, string]> = [
  // A prefixed key, however the provider abbreviates it.
  [/\bsk-[A-Za-z0-9_.-]{4,}/gi, REDACTED],
  // `authorization: Bearer …`, `api_key=…`, `key: "…"`: the keyword stays, the value goes.
  [
    /\b(authorization|proxy-authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|bearer|key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // A raw token with no prefix: a long unbroken run of key characters. Paths and
  // prose are excluded by the alphabet, so a filename survives.
  [/[A-Za-z0-9_+=-]{32,}/g, REDACTED],
]

/**
 * A `reason` in the shape it is persisted: credentials dropped, length capped.
 *
 * The redaction happens here because this is where a reason stops being diagnostic
 * text for the caller and becomes a file in a run directory.
 */
function redactReason(reason: string): string {
  let text = reason
  for (const [pattern, replacement] of CREDENTIALS) text = text.replace(pattern, replacement)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= MAX_REASON_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_REASON_CHARS)}…`
}

/** `path:line` for a candidate, the citation form the rest of the product uses. */
function locationOf(candidate: { path: string; line: number }): string {
  return `${candidate.path}:${candidate.line}`
}

/**
 * What the synthesis stage did, phrased for the reader rather than for a log.
 *
 * The count is diagnostic: it says how many of the verified points survived the
 * ranking. What the reader can act on is *which* ones were left out, so the
 * titles go in — those are the search keys they would use to find the code.
 */
function synthesisGap(synthesis: Synthesis, rendered: LearningPoint[]): string {
  const shown = synthesis.topFive.length
  const total = rendered.length
  if (shown >= total) return `全部 ${total} 个已核实的点都写进了报告。`

  const chosen = new Set(synthesis.topFive)
  const left = rendered.map((point) => point.title).filter((title) => !chosen.has(title))
  const head = `报告正文写了 ${shown} 个点，另有 ${left.length} 个已核实但没有写进正文`
  return left.length === 0 ? `${head}。` : `${head}：${left.join('；')}。`
}

/** The gap recorded when the last stage fails after every judge call succeeded. */
function synthesisFailureReason(error: unknown): string {
  return `synthesis failed: ${messageOf(error)}`
}

/**
 * Fails, before anything is acquired, when no key can be found.
 *
 * `createModelClient` resolves the key at `complete` time on purpose — a user who
 * only runs `ana scan` must not need one — so the client cannot answer this
 * question when it is built. Left to the client, a keyless run would download
 * and extract the repository, judge nothing, and only then say the key was
 * missing: hours of acquisition for an error that is knowable for free. The
 * check therefore happens here, at the head of the run, and says exactly what
 * the client would have said at the first request.
 */
function requireApiKey(explicit: string | undefined): void {
  if (resolveApiKey(explicit) === '') throw new MissingCredentialsError()
}

/**
 * Whether the page will actually show `point`.
 *
 * `render/json.ts` withholds every point whose evidence does not survive its own
 * normaliser, and lists it in `notRendered` instead. The synthesiser only ever
 * sees titles, so offering it one the body withholds is precisely how the TOP
 * list ends up naming a claim the page never shows. The test is the renderer's
 * normaliser rather than a copy of its rule, so the two cannot drift apart.
 */
function willRender(point: LearningPoint): boolean {
  const evidence = (point as { theirs?: { evidence?: unknown } }).theirs?.evidence
  if (!Array.isArray(evidence)) return false
  return evidence.some((item, index) => normalizeEvidence(item, index) !== null)
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
 * Rewrites the manifest's status, keeping every field the scan recorded.
 *
 * The manifest is the only thing that says whether the files beside it belong to
 * one finished analysis, so it is stamped twice: `failed` as soon as this stage
 * starts — the scan completed, this run has not — and `complete` only after the
 * last artifact has landed. Without the second stamp a caller has to probe for
 * `report.md` to tell a finished run from one that is still judging; without the
 * first, a run that dies in the middle leaves the scan's `complete` behind and a
 * directory with no report reads as done.
 */
async function stampStatus(
  run: Run,
  status: RunManifest['status'],
  lang?: RunManifest['lang'],
): Promise<void> {
  const manifest = await run.read<RunManifest>('manifest')
  if (manifest === null) return
  const next: RunManifest = { ...manifest, status }
  // Stamped with the same call that finishes the run, so a directory can always
  // say which language its page was written in.
  if (lang !== undefined) next.lang = lang
  if (status === 'complete') next.completedAt = new Date().toISOString()
  else delete next.completedAt
  await run.write('manifest', next)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ends the run, returning the failure instead of throwing it.
 *
 * Returns rather than throws because a stage error may already be in flight, and a
 * `finally` that throws replaces it: the first error is the one that explains the
 * run, and losing it is how a failure becomes undiagnosable. `run` is nullable
 * because a run that never opened has nothing to close.
 */
async function closeSafely(run: Run | null): Promise<Error | null> {
  if (run === null) return null
  try {
    await closeRun(run)
    return null
  } catch (error) {
    return new Error(
      `anatomy: could not clean up run ${path.basename(run.dir)}: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/**
 * The error that ended the run, with the cleanup failure attached.
 *
 * The original stays the thrown value — same message, same stack — because that is
 * the error a reader can act on; the cleanup failure is attached as its `cause`.
 * When the original already carries a cause (a wrapped stage error), both are
 * aggregated instead of one cause being overwritten.
 */
function withCleanupFailure(failure: unknown, cleanup: Error): Error {
  const original = failure instanceof Error ? failure : new Error(String(failure))
  if ((original as { cause?: unknown }).cause === undefined) {
    Object.defineProperty(original, 'cause', { value: cleanup, configurable: true, writable: true })
    return original
  }
  return new AggregateError(
    [original, cleanup],
    `${original.message} (and the run directory was left behind: ${cleanup.message})`,
    { cause: original },
  )
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
  const model = resolveModelName(opts.model)

  // The two things the run cannot do without are settled before it acquires
  // anything: a caller with no key, or a model whose budget cannot be clamped,
  // learns it without paying for a download and an extraction first.
  opts.onStage?.({ stage: 'acquire', detail: input })
  if (opts.client === undefined) requireApiKey(opts.apiKey)
  const client = opts.client ?? createModelClient({ model, apiKey: opts.apiKey })
  const budget = clampBudget(opts.budget ?? DEFAULT_BUDGET_TOKENS, model)

  // Held outside the `try` because the scan can throw *after* it opened the run
  // and extracted the tree, and it never returns a handle when it does. Without
  // one, every failed run leaves a copy of the repository behind.
  let run: Run | null = null
  let failure: unknown

  try {
    const scanned = await scanRepo(input, {
      subpath: opts.subpath,
      ref: opts.ref,
      topK: opts.top,
      baseDir: opts.baseDir,
      // The judge reads the tree; `closeRun` deletes it once the report is written.
      keepTree: true,
      deps: opts.deps,
      onRun: (opened) => {
        run = opened
      },
    })
    run = scanned.run

    // The scan called its own artifacts complete; this run also owes the report.
    await stampStatus(run, 'failed')

    const fitted = fitCandidates(
      scanned.candidates,
      (candidate) => candidateContext(candidate, lang),
      budget,
    )

    // `fitted.dropped` is the count; the identities are what a reader needs, and
    // `fitCandidates` keeps the same objects, so the cut set is recoverable.
    const affordable = new Set<Candidate>(fitted.kept)
    const cut = scanned.candidates.filter((candidate) => !affordable.has(candidate))

    opts.onStage?.({ stage: 'judge', done: 0, total: fitted.kept.length })
    const seenProviderErrors = new Set<string>()
    const judged = await judgeCandidates({
      client,
      root: scanned.root,
      candidates: fitted.kept,
      scope: scanned.scope,
      lang,
      runId: scanned.runId,
      onCandidate: (done, total, path) => opts.onStage?.({ stage: 'judge', done, total, detail: path }),
      // Printed once per distinct provider failure. Without this a rejected request
      // is a status code and nothing else — the terminal is the one place the
      // provider's own words can go, since the report cannot carry them.
      onProviderError: (detail) => {
        if (seenProviderErrors.has(detail.excerpt)) return
        seenProviderErrors.add(detail.excerpt)
        opts.onProviderError?.(detail)
      },
      // The budget already decided how many candidates there are; the judge must
      // not add a second, invisible cut on top of it.
      limit: fitted.kept.length,
    })

    opts.onStage?.({ stage: 'rank', detail: `${judged.points.length} 个点已取证` })
    // Ranked after validation, so a point whose evidence was thrown away cannot
    // take a top-five slot from a point that has some.
    const points = rankPoints(judged.points, fitted.kept)

    // Only the points the page will actually show. A point kept on zero evidence
    // is real work for `points.json` and a real gap for `notRendered`, but it is
    // not a candidate for the TOP list, and the synthesiser must not be told
    // otherwise.
    const renderedPoints = points.filter(willRender)
    const renderedTitles = new Set(renderedPoints.map((point) => point.title))

    // Redacted here rather than at each sink: this array is `skipped.json` and the
    // report tail at once, and a reason that reached one of them unredacted would
    // have reached the disk.
    const judgedSkips: AnalyzeSkip[] = [
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
    ].map((entry) => ({ ...entry, reason: redactReason(entry.reason) }))

    // The artifacts the judging call paid for land before the one stage that can
    // still fail. A 5xx at synthesis must not cost a run that already judged
    // every candidate: without these writes, `ana report` answers "no such run"
    // for a run whose tokens were all spent.
    await scanned.run.write('points', points)
    await scanned.run.write('validation', judged.validation)
    await scanned.run.write('skipped', judgedSkips)

    let synthesis: Synthesis
    let synthesisFailure = ''
    opts.onStage?.({
      stage: 'synthesise',
      detail: `${renderedPoints.length} 个点已核实，从中挑最值得学的`,
    })
    try {
      synthesis = await synthesize({
        client,
        profile: scanned.profile,
        structure: scanned.structure,
        titles: renderedPoints.map((point) => point.title),
        lang,
        maxPoints: opts.reportPoints,
      })
    } catch (error) {
      // A transport failure here is not worth the run. What the model would have
      // written is missing; what was verified is not, and the report says so.
      synthesisFailure = synthesisFailureReason(error)
      synthesis = { problem: '', topFive: [] }
    }

    // A second line of defence: `synthesize` only answers with titles it was
    // offered, but the page must never advertise a claim its body withholds even
    // if that changes.
    const topFive = synthesis.topFive.filter((title) => renderedTitles.has(title))

    const skipped: AnalyzeSkip[] = [
      ...judgedSkips,
      {
        path: '',
        line: 0,
        reason: redactReason(
          synthesisFailure === ''
            ? synthesisGap(synthesis, renderedPoints)
            : synthesisFailure,
        ),
      },
    ]

    const report: ReportInput = {
      source: input,
      problem: synthesis.problem,
      topFive,
      points,
      validation: judged.validation,
      profile: scanned.profile,
      scope: scanned.scope,
      skipped: skipLines(skipped, cut.length, budget),
      candidates: scanned.candidates,
      structure: scanned.structure,
      // The page written now and the page `ana report` writes later must agree.
      // Without this the fresh `report.md` is Chinese while a re-render of the same
      // run is English, because the re-render reads `manifest.lang` and this did not.
      lang,
    }

    const reportPath = await persist(
      scanned.run,
      report,
      points,
      judged.validation,
      // `synthesis.json` is the brief the page was rendered from, not the raw
      // reply: a title dropped by the filter above is not in the report.
      { problem: synthesis.problem, topFive },
      skipped,
    )

    // Everything the run owes the reader is on disk, including the page itself.
    await stampStatus(run, 'complete', lang)

    return { runId: scanned.runId, reportPath }
  } catch (error) {
    failure = error
    throw error
  } finally {
    // The artifacts are the run; the tree is only how the judge reached them.
    const cleanup = await closeSafely(run)
    if (cleanup !== null) {
      if (failure === undefined) throw cleanup
      throw withCleanupFailure(failure, cleanup)
    }
  }
}
