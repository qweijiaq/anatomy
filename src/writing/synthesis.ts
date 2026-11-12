/**
 * The report's first section: what this repository is for, and which five
 * things are worth learning from it.
 *
 * That answer cannot be assembled from the individual judgements — each judge
 * saw one candidate and one window — so it is written in one place, by one call,
 * with everything the analyser knows but nothing it must not leak:
 *
 * - the `Profile` (languages, manifests, entry points, notes);
 * - a *summary* of the structure index (how many modules, which few are
 *   imported most, how many imports did not resolve), never the index itself;
 * - the point titles, and only the titles. No code, no snippets, no
 *   mechanisms: the model is choosing between claims that were already
 *   verified, not making new ones.
 *
 * `topFive` is then checked against the titles it was given, so the top of the
 * report can never advertise a point the report does not contain. A reply that
 * fails that check — or is not JSON at all — costs one retry and then falls
 * back to the caller's own order, which is why this stage never throws for a
 * bad model answer, only for a transport failure the client already retried.
 */

import type { Profile, StructureIndex } from '../contracts/types.js'
import type { ModelClient, ModelRequest } from './client.js'
import { MissingCredentialsError, ModelRequestError } from './client.js'
import type { Lang } from './prompts/zh.js'

/** How many modules the summary names as "most imported". */
export const TOP_IMPORTED_LIMIT = 5
/** One first attempt plus one repair. A third wrong reply is not a prompt bug. */
const MAX_ATTEMPTS = 2
/** Fewer surviving titles than this means the reply did not do the task. */
const MIN_TOP_FIVE = 3
const MAX_TOP_FIVE = 5
const MAX_REASON_CHARS = 200

const SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['problem', 'topFive'],
  properties: {
    problem: { type: 'string' },
    topFive: { type: 'array', items: { type: 'string' } },
  },
} as const

export type Synthesis = { problem: string; topFive: string[] }

export type SynthesisDeps = {
  client: ModelClient
  profile: Profile
  structure: StructureIndex
  /** The surviving point titles, already in the caller's preferred order. */
  titles: string[]
  /** Output language; `zh` is the shipped default. */
  lang?: Lang
}

export type StructureSummary = {
  moduleCount: number
  unresolved: number
  topImported: Array<{ module: string; imports: number }>
}

// --- structure summary ----------------------------------------------------

/**
 * The shape of the module graph, compressed to what fits in a sentence.
 *
 * The full index is thousands of paths and would spend the prompt budget on
 * detail the reader never sees; the hub modules and the unresolved count are
 * what let the model say something true about the architecture.
 */
export function summarizeStructure(
  structure: StructureIndex,
  limit: number = TOP_IMPORTED_LIMIT,
): StructureSummary {
  const modules = Array.isArray(structure?.modules) ? structure.modules : []
  const inbound = new Map<string, number>()

  for (const module of modules) {
    const imports = Array.isArray(module?.imports) ? module.imports : []
    for (const edge of imports) {
      const target = edge?.resolved
      if (typeof target !== 'string' || target === '') continue
      inbound.set(target, (inbound.get(target) ?? 0) + 1)
    }
  }

  const topImported = [...inbound.entries()]
    .map(([module, imports]) => ({ module, imports }))
    .sort((a, b) =>
      a.imports === b.imports
        ? a.module < b.module
          ? -1
          : a.module > b.module
            ? 1
            : 0
        : b.imports - a.imports,
    )
    .slice(0, Math.max(0, limit))

  return {
    moduleCount: modules.length,
    unresolved:
      typeof structure?.unresolved === 'number' && Number.isFinite(structure.unresolved)
        ? structure.unresolved
        : 0,
    topImported,
  }
}

// --- prompt ---------------------------------------------------------------

const SYSTEM_ZH = `你是 anatomy 的综述器。输入只有三样东西：仓库画像、模块图摘要、以及已经核对过的学习点标题。
任务：用一段话说明这个仓库是做什么的、为什么它值得读；并从给定标题中挑出最值得学习的五条。

只输出一个 JSON 对象：不要 Markdown 代码围栏，不要任何解释文字。
输出形状：{"problem": string, "topFive": string[]}

硬性规则：
1. 输出语言必须是简体中文。
2. topFive 的每一项必须从"学习点标题"里逐字复制：不得改写、不得翻译、不得截断、不得自己编造标题。
3. topFive 最多五条，按"最值得学"排序。宁少勿滥：三条好过五条凑数。
4. 你看不到代码，只有画像、摘要和标题。不要描述具体实现，不要引用代码，也不要在 problem 里写任何不出现在这些标题里的结论。`

const SYSTEM_EN = `You are the synthesiser for anatomy. The input is exactly three things: a repository profile, a module graph summary, and the titles of the learning points that already passed verification.
Task: say in one paragraph what this repository is for and why it is worth reading, then pick the five most worth learning from the given titles.

Output exactly one JSON object: no Markdown fences, no prose around it.
Shape: {"problem": string, "topFive": string[]}

Hard rules:
1. The output language must be English.
2. Every item of topFive must be copied verbatim from the point titles: no rewriting, no translation, no truncation, no title of your own.
3. topFive holds at most five items, ordered by what is most worth learning. Fewer and better beats five and padded.
4. You cannot see code — only the profile, the summary and the titles. Do not describe an implementation, do not quote code, and do not put a claim in problem that these titles do not support.`

function systemPrompt(lang: Lang): string {
  return lang === 'en' ? SYSTEM_EN : SYSTEM_ZH
}

function listOrNone(lang: Lang, items: string[]): string {
  return items.length === 0 ? (lang === 'en' ? '(none)' : '（无）') : items.join(', ')
}

function yesNo(lang: Lang, value: boolean): string {
  if (lang === 'en') return value ? 'yes' : 'no'
  return value ? '有' : '无'
}

/** Languages by file count, largest first: a one-line answer to "what is this". */
function languagesBySize(profile: Profile): Array<[string, number]> {
  const entries = Object.entries(profile.languages ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  )
  return entries.sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
}

function profileBlock(lang: Lang, profile: Profile): string {
  const languages = languagesBySize(profile).map(([name, count]) => `${name} ${count}`)
  const manifests = Array.isArray(profile.manifests) ? profile.manifests : []
  const entryPoints = Array.isArray(profile.entryPoints) ? profile.entryPoints : []
  const notes = Array.isArray(profile.notes) ? profile.notes : []

  if (lang === 'en') {
    return [
      'Repository profile',
      `- languages (by file count): ${listOrNone(lang, languages)}`,
      `- manifests: ${listOrNone(lang, manifests)}`,
      `- entry points: ${listOrNone(lang, entryPoints)}`,
      `- tests: ${yesNo(lang, profile.hasTests)} / CI: ${yesNo(lang, profile.hasCi)} / docs: ${yesNo(lang, profile.hasDocs)}`,
      `- notes: ${listOrNone(lang, notes)}`,
    ].join('\n')
  }
  return [
    '仓库画像',
    `- 语言（按文件数）: ${listOrNone(lang, languages)}`,
    `- 清单文件: ${listOrNone(lang, manifests)}`,
    `- 入口: ${listOrNone(lang, entryPoints)}`,
    `- 测试: ${yesNo(lang, profile.hasTests)} / CI: ${yesNo(lang, profile.hasCi)} / 文档: ${yesNo(lang, profile.hasDocs)}`,
    `- 备注: ${listOrNone(lang, notes)}`,
  ].join('\n')
}

function summaryBlock(lang: Lang, summary: StructureSummary): string {
  const hubs = summary.topImported.map((item) => `${item.module} (${item.imports})`)
  if (lang === 'en') {
    return [
      'Module graph summary',
      `- modules: ${summary.moduleCount}`,
      `- most-imported modules: ${listOrNone(lang, hubs)}`,
      `- unresolved imports: ${summary.unresolved}`,
    ].join('\n')
  }
  return [
    '模块图摘要',
    `- 模块数: ${summary.moduleCount}`,
    `- 被依赖最多的模块: ${listOrNone(lang, hubs)}`,
    `- 未解析导入: ${summary.unresolved}`,
  ].join('\n')
}

function titlesBlock(lang: Lang, titles: string[]): string {
  const heading =
    lang === 'en'
      ? 'Point titles (topFive may only copy these verbatim)'
      : '学习点标题（topFive 只能从这里逐字复制）'
  const lines = titles.map((title, index) => `${index + 1}. ${title}`)
  return `${heading}\n${lines.join('\n')}`
}

/** A one-shot repair instruction; `reason` is our own text, never model output. */
function repairNote(lang: Lang, reason: string): string {
  const shortened =
    reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS)}…`
  return lang === 'en'
    ? `\n\nThe previous reply was unusable: ${shortened}\nReply again with one complete JSON object.`
    : `\n\n上一次回复不能使用：${shortened}\n请重新输出一个完整的 JSON 对象。`
}

/** The whole request, pure and therefore assertable: no disk, no network. */
export function buildSynthesisPrompt(input: {
  profile: Profile
  structure: StructureIndex
  titles: string[]
  lang?: Lang
}): { system: string; user: string; schema: object } {
  const lang: Lang = input.lang ?? 'zh'
  const summary = summarizeStructure(input.structure)
  const user = [
    profileBlock(lang, input.profile),
    summaryBlock(lang, summary),
    titlesBlock(lang, input.titles),
  ].join('\n\n')
  return { system: systemPrompt(lang), user, schema: SYNTHESIS_SCHEMA }
}

// --- reply ----------------------------------------------------------------

type Parsed = { ok: true; problem: string; topFive: string[] } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uniqueTitles(titles: unknown): string[] {
  const list = Array.isArray(titles) ? titles : []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const title = item.trim()
    if (title === '' || seen.has(title)) continue
    seen.add(title)
    kept.push(title)
  }
  return kept
}

/**
 * Shape check plus the subset rule.
 *
 * A title the model invented is not an option the report can offer, so it is
 * dropped rather than repaired: the surviving items are returned as they were
 * given, never as the model spelled them.
 */
function parseReply(raw: unknown, titles: string[]): Parsed {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, reason: 'the reply is not JSON' }
    }
  }
  if (!isRecord(value)) return { ok: false, reason: 'the reply is not a JSON object' }

  const problem = value['problem']
  if (typeof problem !== 'string' || problem.trim() === '') {
    return { ok: false, reason: 'the reply has no problem statement' }
  }

  const topFive = value['topFive']
  if (!Array.isArray(topFive) || !topFive.every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'the reply has no topFive string[]' }
  }

  const known = new Set(titles)
  const chosen: string[] = []
  for (const item of topFive) {
    // Whitespace is the one difference worth forgiving: a model that indents a
    // title copied it, and the copy is replaced by the caller's exact string.
    const title = item.trim()
    if (!known.has(title) || chosen.includes(title)) continue
    chosen.push(title)
    if (chosen.length === MAX_TOP_FIVE) break
  }

  return { ok: true, problem: problem.trim(), topFive: chosen }
}

// --- deterministic fallback -----------------------------------------------

/**
 * What the report says when the model could not be made to say anything.
 *
 * Deterministic, built from the profile and the summary, and never an apology:
 * the reader is told what the repository is; the ranking already carries the
 * rest.
 */
function fallbackProblem(
  lang: Lang,
  profile: Profile,
  summary: StructureSummary,
): string {
  const language = languagesBySize(profile)[0]?.[0]
  if (lang === 'en') {
    const lead =
      language === undefined
        ? `This repository has ${summary.moduleCount} modules`
        : `This is a ${language} repository with ${summary.moduleCount} modules`
    return `${lead}. The five points below are what is most worth learning from it.`
  }
  const lead =
    language === undefined
      ? `这个仓库共有 ${summary.moduleCount} 个模块`
      : `这是一个以 ${language} 为主、共 ${summary.moduleCount} 个模块的仓库`
  return `${lead}。下面五条是其中最值得学习的方向。`
}

// --- synthesis ------------------------------------------------------------

/**
 * The problem statement and the top five, or a deterministic stand-in for them.
 *
 * Throws only for failures no retry can fix: a missing key, or a transport
 * failure the client has already retried to exhaustion. A bad reply costs one
 * repair attempt and then the fallback, because a report without a summary is
 * still a report.
 */
export async function synthesize(deps: SynthesisDeps): Promise<Synthesis> {
  const lang: Lang = deps.lang ?? 'zh'
  const titles = uniqueTitles(deps.titles)
  const summary = summarizeStructure(deps.structure)
  const fallback = (): Synthesis => ({
    problem: fallbackProblem(lang, deps.profile, summary),
    topFive: titles.slice(0, MAX_TOP_FIVE),
  })

  // Nothing to rank: no call, no tokens, and a summary that is still true.
  if (titles.length === 0) return fallback()

  const prompt = buildSynthesisPrompt({
    profile: deps.profile,
    structure: deps.structure,
    titles,
    lang,
  })
  const required = Math.min(MIN_TOP_FIVE, titles.length)
  let reason = ''

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const request: ModelRequest = {
      system: prompt.system,
      user: attempt === 0 ? prompt.user : `${prompt.user}${repairNote(lang, reason)}`,
      schema: prompt.schema,
    }

    let raw: unknown
    try {
      raw = (await deps.client.complete(request)).json
    } catch (error) {
      if (error instanceof MissingCredentialsError) throw error
      // The client already spent its retry budget on a 429/5xx/network failure.
      if (error instanceof ModelRequestError) throw error
      // Anything else is a reply that arrived and was unusable: one repair, then
      // the fallback. The tokens are gone either way.
      reason = messageOf(error)
      continue
    }

    const parsed = parseReply(raw, titles)
    if (!parsed.ok) {
      reason = parsed.reason
      continue
    }
    if (parsed.topFive.length < required) {
      reason = `only ${parsed.topFive.length} of the returned titles came from the provided list`
      continue
    }
    return { problem: parsed.problem, topFive: parsed.topFive }
  }

  return fallback()
}
